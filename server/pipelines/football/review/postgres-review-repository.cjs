const { randomUUID } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");
const { validateResourceId } = require("../../../repositories/ids.cjs");
const { mapJob } = require("../../../queue/postgres-job-queue.cjs");
const {
  assertCandidateSet,
  normalizeCandidate,
  publicCandidate,
  stableStringify,
  hashValue,
  validateCandidateId,
} = require("./candidate-contract.cjs");
const {
  validateReviewId,
  validateSourceRevision,
  validateVersion,
} = require("./review-repository.cjs");

const DECISION_ACTIONS = new Set(["select", "reject", "regenerate"]);
const READY_PREVIEW_MINIMUM = 2;

function reviewNotFound() {
  return new AppError(
    "FOOTBALL_REVIEW_NOT_FOUND",
    SAFE_MESSAGES.FOOTBALL_REVIEW_NOT_FOUND,
    404,
  );
}

function candidateInvalid(status = 409) {
  return new AppError(
    "FOOTBALL_REVIEW_CANDIDATE_INVALID",
    SAFE_MESSAGES.FOOTBALL_REVIEW_CANDIDATE_INVALID,
    status,
  );
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function json(value, fallback = {}) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value);
  return JSON.parse(JSON.stringify(value));
}

function mapCandidate(row, review) {
  const editPlan = json(row.edit_plan_json);
  return normalizeCandidate({
    id: row.id,
    projectId: review.projectId,
    sourceJobId: review.sourceJobId,
    sourceRevision: review.sourceRevision,
    sourceStart: Number(row.source_start),
    sourceEnd: Number(row.source_end),
    confidence: Number(row.confidence),
    purpose: json(row.purpose_json),
    phaseWindow: {
      phase: json(row.purpose_json).code,
      sourceStart: Number(row.source_start),
      sourceEnd: Number(row.source_end),
    },
    evidence: json(row.evidence_json),
    uncertainty: json(row.uncertainty_json),
    framing: json(row.framing_json),
    captions: json(row.captions_json),
    pacing: editPlan.reviewEditorial && editPlan.reviewEditorial.pacing,
    qualityWarnings: json(row.warnings_json, []),
    editorialSignature: String(row.editorial_signature || "").trim(),
    planHash: String(row.plan_hash || "").trim(),
    preview: {
      status: row.preview_status,
      artifactId: row.preview_artifact_id,
      checksumSha256: row.preview_checksum_sha256
        ? String(row.preview_checksum_sha256).trim()
        : null,
      durationSeconds: row.preview_duration_seconds === null
        ? null
        : Number(row.preview_duration_seconds),
      expiresAt: iso(row.preview_expires_at),
    },
    editPlan,
  }, {
    projectId: review.projectId,
    sourceJobId: review.sourceJobId,
    sourceRevision: review.sourceRevision,
    sourceDurationSeconds: Math.max(Number(row.source_end) + 1, 1),
  });
}

function mapReview(row, candidates = []) {
  if (!row) return null;
  return {
    schemaVersion: 2,
    id: row.id,
    ownerId: row.owner_id,
    projectId: row.project_id,
    sourceJobId: row.source_job_id,
    sourceUploadId: row.source_upload_id,
    sourceRevision: String(row.source_revision).trim(),
    projectRevision: Number(row.project_revision),
    version: Number(row.version),
    status: row.status,
    selectedCandidateId: row.selected_candidate_id || null,
    rightsConfirmed: row.rights_confirmed === true,
    renderJobId: row.render_job_id || null,
    regenerationJobId: row.regeneration_job_id || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    candidates,
  };
}

function decisionRequestHash(input) {
  return hashValue({
    reviewId: input.reviewId,
    expectedVersion: Number(input.expectedVersion),
    expectedSourceRevision: input.expectedSourceRevision,
    action: input.action,
    candidateId: input.candidateId || null,
    reviewerNote: input.reviewerNote || "",
  });
}

async function appendAudit(transaction, record) {
  await transaction.query(
    `INSERT INTO football_review_audit(
       review_id, owner_id, sequence, event_type, from_status, to_status,
       version, candidate_id, job_id, reason_code
     )
     SELECT
       $1, $2, COALESCE(max(sequence), 0) + 1, $3, $4, $5,
       $6, $7, $8, $9
     FROM football_review_audit
     WHERE review_id = $1`,
    [
      record.reviewId,
      record.ownerId,
      record.eventType,
      record.fromStatus || null,
      record.toStatus,
      record.version,
      record.candidateId || null,
      record.jobId || null,
      record.reasonCode || null,
    ],
  );
}

class PostgresFootballReviewRepository {
  constructor(options = {}) {
    if (!options.persistenceAdapter || !options.jobQueue) {
      throw new AppError(
        "ADAPTER_CONTRACT_INVALID",
        SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
        500,
      );
    }
    if (typeof options.jobQueue.enqueueInTransaction !== "function") {
      throw new AppError(
        "ADAPTER_CONTRACT_INVALID",
        SAFE_MESSAGES.ADAPTER_CONTRACT_INVALID,
        500,
      );
    }
    this.persistence = options.persistenceAdapter;
    this.jobQueue = options.jobQueue;
    this.randomUUID = options.randomUUID || randomUUID;
  }

  async withTransaction(callback) {
    return await this.persistence.withTransaction(callback);
  }

  async loadOwnedReview(transaction, reviewId, ownerId, lock = false) {
    const result = await transaction.query(
      `SELECT *
       FROM football_reviews
       WHERE id = $1 AND owner_id = $2
       ${lock ? "FOR UPDATE" : ""}`,
      [validateReviewId(reviewId), validateResourceId(ownerId, "usr")],
    );
    if (!result.rowCount) throw reviewNotFound();
    return result.rows[0];
  }

  async loadCandidates(transaction, row) {
    const result = await transaction.query(
      `SELECT *
       FROM football_review_candidates
       WHERE review_id = $1 AND owner_id = $2
       ORDER BY created_at, id`,
      [row.id, row.owner_id],
    );
    const review = mapReview(row);
    return result.rows.map((candidate) => mapCandidate(candidate, review));
  }

  async getOwnedReview(reviewId, ownerId) {
    return await this.withTransaction(async (transaction) => {
      const row = await this.loadOwnedReview(transaction, reviewId, ownerId);
      return mapReview(row, await this.loadCandidates(transaction, row));
    });
  }

  async createReviewAndEnqueuePreviews(input = {}) {
    const ownerId = validateResourceId(input.ownerId, "usr");
    const projectId = validateResourceId(input.projectId, "prj");
    const sourceJobId = validateResourceId(input.sourceJobId, "job");
    const sourceUploadId = validateResourceId(input.sourceUploadId, "upl");
    const sourceRevision = validateSourceRevision(input.sourceRevision);
    const projectRevision = validateVersion(input.projectRevision, "projectRevision");
    const candidates = assertCandidateSet(input.candidates);
    if (input.rightsConfirmed !== true) {
      throw new AppError(
        "FOOTBALL_REVIEW_RIGHTS_REQUIRED",
        SAFE_MESSAGES.FOOTBALL_REVIEW_RIGHTS_REQUIRED,
        409,
      );
    }
    return await this.withTransaction(async (transaction) => {
      const existing = await transaction.query(
        `SELECT *
         FROM football_reviews
         WHERE project_id = $1
           AND source_job_id = $2
           AND source_revision = $3`,
        [projectId, sourceJobId, sourceRevision],
      );
      if (existing.rowCount) {
        if (existing.rows[0].owner_id !== ownerId) throw reviewNotFound();
        const row = existing.rows[0];
        const previewJob = await transaction.query(
          `SELECT *
           FROM jobs
           WHERE owner_id = $1
             AND action = 'football_review_preview_batch'
             AND payload_json ->> 'reviewId' = $2
           ORDER BY created_at
           LIMIT 1`,
          [ownerId, row.id],
        );
        return {
          review: mapReview(row, await this.loadCandidates(transaction, row)),
          job: mapJob(previewJob.rows[0]),
          replayed: true,
        };
      }

      const reviewId = input.reviewId || `fbr_${this.randomUUID()}`;
      validateReviewId(reviewId);
      const inserted = await transaction.query(
        `INSERT INTO football_reviews(
           id, owner_id, project_id, source_job_id, source_upload_id,
           source_revision, project_revision, version, status, rights_confirmed
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'preparing', true)
         RETURNING *`,
        [
          reviewId,
          ownerId,
          projectId,
          sourceJobId,
          sourceUploadId,
          sourceRevision,
          projectRevision,
        ],
      );
      for (const candidate of candidates) {
        const safe = normalizeCandidate(candidate, {
          projectId,
          sourceJobId,
          sourceRevision,
          sourceDurationSeconds: Math.max(candidate.sourceEnd + 1, 1),
        });
        await transaction.query(
          `INSERT INTO football_review_candidates(
             id, review_id, owner_id, schema_version, source_start, source_end,
             confidence, purpose_json, evidence_json, uncertainty_json,
             framing_json, captions_json, warnings_json, edit_plan_json,
             editorial_signature, plan_hash, preview_status
           )
           VALUES (
             $1, $2, $3, 2, $4, $5,
             $6, $7::jsonb, $8::jsonb, $9::jsonb,
             $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb,
             $14, $15, 'queued'
           )`,
          [
            safe.id,
            reviewId,
            ownerId,
            safe.sourceStart,
            safe.sourceEnd,
            safe.confidence,
            JSON.stringify(safe.purpose),
            JSON.stringify(safe.evidence),
            JSON.stringify(safe.uncertainty),
            JSON.stringify(safe.framing),
            JSON.stringify(safe.captions),
            JSON.stringify(safe.qualityWarnings),
            JSON.stringify(safe.editPlan),
            safe.editorialSignature,
            safe.planHash,
          ],
        );
      }
      const queued = await this.jobQueue.enqueueInTransaction(transaction, {
        ownerId,
        projectId,
        uploadId: sourceUploadId,
        action: "football_review_preview_batch",
        pipelineType: "football",
        payload: {
          reviewId,
          sourceJobId,
          sourceUploadId,
          sourceRevision,
          candidateIds: candidates.map((candidate) => candidate.id),
        },
        traceparent: input.traceparent || null,
      }, {
        idempotencyKey: `football-preview-${reviewId}`,
      });
      await appendAudit(transaction, {
        reviewId,
        ownerId,
        eventType: "review_created",
        toStatus: "preparing",
        version: 1,
        jobId: queued.job.id,
      });
      const row = inserted.rows[0];
      return {
        review: mapReview(row, await this.loadCandidates(transaction, row)),
        job: queued.job,
        replayed: false,
      };
    });
  }

  async beginCandidatePreview(input = {}) {
    const ownerId = validateResourceId(input.ownerId, "usr");
    const candidateId = validateCandidateId(input.candidateId);
    const artifactId = validateResourceId(
      input.artifactId || `art_${this.randomUUID()}`,
      "art",
    );
    return await this.withTransaction(async (transaction) => {
      const reviewRow = await this.loadOwnedReview(
        transaction,
        input.reviewId,
        ownerId,
        true,
      );
      const candidate = await transaction.query(
        `SELECT *
         FROM football_review_candidates
         WHERE id = $1 AND review_id = $2 AND owner_id = $3
         FOR UPDATE`,
        [candidateId, reviewRow.id, ownerId],
      );
      if (!candidate.rowCount) throw candidateInvalid(404);
      const row = candidate.rows[0];
      if (!["queued", "failed", "expired"].includes(row.preview_status)) {
        if (row.preview_status === "rendering") {
          const existingArtifact = await transaction.query(
            `SELECT storage_key, retention_until
             FROM artifacts
             WHERE id = $1 AND owner_id = $2 AND status = 'staging'`,
            [row.preview_artifact_id, ownerId],
          );
          if (!existingArtifact.rowCount) throw candidateInvalid();
          return {
            artifactId: row.preview_artifact_id,
            storageKey: existingArtifact.rows[0].storage_key,
            expiresAt: iso(existingArtifact.rows[0].retention_until),
            sourceRevision: reviewRow.source_revision,
            planHash: String(row.plan_hash).trim(),
            replayed: true,
          };
        }
        throw candidateInvalid();
      }
      await transaction.query(
        `INSERT INTO artifacts(
           id, owner_id, owner_project_id, owner_job_id, type, status,
           storage_key, content_type, retention_until, metadata_json
         )
         VALUES (
           $1, $2, $3, $4, 'preview', 'staging',
           $5, 'video/mp4', $6, $7::jsonb
         )`,
        [
          artifactId,
          ownerId,
          reviewRow.project_id,
          input.jobId || null,
          input.storageKey,
          input.expiresAt,
          JSON.stringify({
            reviewId: reviewRow.id,
            candidateId,
            sourceRevision: reviewRow.source_revision,
            planHash: String(row.plan_hash).trim(),
          }),
        ],
      );
      await transaction.query(
        `UPDATE football_review_candidates
         SET
           preview_status = 'rendering',
           preview_artifact_id = $4,
           preview_checksum_sha256 = NULL,
           preview_duration_seconds = NULL,
           preview_expires_at = $5
         WHERE id = $1 AND review_id = $2 AND owner_id = $3`,
        [candidateId, reviewRow.id, ownerId, artifactId, input.expiresAt],
      );
      return {
        artifactId,
        storageKey: input.storageKey,
        expiresAt: input.expiresAt,
        sourceRevision: reviewRow.source_revision,
        planHash: String(row.plan_hash).trim(),
        replayed: false,
      };
    });
  }

  async publishCandidatePreview(input = {}) {
    const ownerId = validateResourceId(input.ownerId, "usr");
    const checksum = String(input.checksumSha256 || "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(checksum)) throw candidateInvalid(400);
    return await this.withTransaction(async (transaction) => {
      const reviewRow = await this.loadOwnedReview(
        transaction,
        input.reviewId,
        ownerId,
        true,
      );
      const candidate = await transaction.query(
        `SELECT *
         FROM football_review_candidates
         WHERE id = $1 AND review_id = $2 AND owner_id = $3
         FOR UPDATE`,
        [validateCandidateId(input.candidateId), reviewRow.id, ownerId],
      );
      if (!candidate.rowCount) throw candidateInvalid(404);
      const row = candidate.rows[0];
      const manifest = input.manifest || {};
      if (
        row.preview_status !== "rendering"
        || row.preview_artifact_id !== input.artifactId
        || manifest.candidateId !== row.id
        || manifest.sourceRevision !== reviewRow.source_revision
        || manifest.planHash !== String(row.plan_hash).trim()
        || manifest.checksumSha256 !== checksum
      ) {
        throw candidateInvalid();
      }
      const artifact = await transaction.query(
        `UPDATE artifacts
         SET
           status = 'available',
           checksum_sha256 = $3,
           byte_size = $4,
           retention_until = $5,
           metadata_json = metadata_json || $6::jsonb,
           updated_at = clock_timestamp()
         WHERE id = $1
           AND owner_id = $2
           AND status = 'staging'
         RETURNING id`,
        [
          input.artifactId,
          ownerId,
          checksum,
          input.byteSize,
          input.expiresAt,
          JSON.stringify({ previewManifest: manifest }),
        ],
      );
      if (!artifact.rowCount) throw candidateInvalid();
      await transaction.query(
        `UPDATE football_review_candidates
         SET
           preview_status = 'ready',
           preview_checksum_sha256 = $4,
           preview_duration_seconds = $5,
           preview_expires_at = $6
         WHERE id = $1 AND review_id = $2 AND owner_id = $3`,
        [
          row.id,
          reviewRow.id,
          ownerId,
          checksum,
          input.durationSeconds,
          input.expiresAt,
        ],
      );
      const count = await transaction.query(
        `SELECT count(*)::integer AS count
         FROM football_review_candidates
         WHERE review_id = $1
           AND owner_id = $2
           AND preview_status = 'ready'
           AND preview_expires_at > clock_timestamp()`,
        [reviewRow.id, ownerId],
      );
      let updated = reviewRow;
      if (
        Number(count.rows[0].count) >= READY_PREVIEW_MINIMUM
        && reviewRow.status === "preparing"
      ) {
        const ready = await transaction.query(
          `UPDATE football_reviews
           SET status = 'pending', version = version + 1,
               updated_at = clock_timestamp()
           WHERE id = $1 AND owner_id = $2
           RETURNING *`,
          [reviewRow.id, ownerId],
        );
        updated = ready.rows[0];
        await appendAudit(transaction, {
          reviewId: reviewRow.id,
          ownerId,
          eventType: "review_ready",
          fromStatus: "preparing",
          toStatus: "pending",
          version: Number(updated.version),
        });
      }
      return mapReview(updated, await this.loadCandidates(transaction, updated));
    });
  }

  async failCandidatePreview(input = {}) {
    const ownerId = validateResourceId(input.ownerId, "usr");
    const candidateId = validateCandidateId(input.candidateId);
    return await this.withTransaction(async (transaction) => {
      const reviewRow = await this.loadOwnedReview(
        transaction,
        input.reviewId,
        ownerId,
        true,
      );
      const failed = await transaction.query(
        `UPDATE football_review_candidates
         SET preview_status = 'failed'
         WHERE id = $1
           AND review_id = $2
           AND owner_id = $3
           AND preview_status IN ('queued', 'rendering')
         RETURNING preview_artifact_id`,
        [candidateId, reviewRow.id, ownerId],
      );
      if (!failed.rowCount) throw candidateInvalid(404);
      const artifactId = failed.rows[0].preview_artifact_id;
      if (artifactId) {
        await transaction.query(
          `UPDATE artifacts
           SET status = 'delete_pending', updated_at = clock_timestamp()
           WHERE id = $1
             AND owner_id = $2
             AND status IN ('staging', 'available', 'failed')`,
          [artifactId, ownerId],
        );
        await transaction.query(
          `INSERT INTO storage_operations(
             id, owner_id, artifact_id, operation, status,
             next_attempt_at, error_code
           )
           VALUES (
             $1, $2, $3, 'delete_object', 'queued',
             clock_timestamp(), $4
           )
           ON CONFLICT (id) DO NOTHING`,
          [
            input.operationId || `sop_${this.randomUUID()}`,
            ownerId,
            artifactId,
            input.errorCode || "RENDER_FAILED",
          ],
        );
      }
      const viable = await transaction.query(
        `SELECT count(*)::integer AS count
         FROM football_review_candidates
         WHERE review_id = $1
           AND owner_id = $2
           AND (
             (preview_status = 'ready' AND preview_expires_at > clock_timestamp())
             OR preview_status IN ('queued', 'rendering')
           )`,
        [reviewRow.id, ownerId],
      );
      let updated = reviewRow;
      if (
        Number(viable.rows[0].count) < READY_PREVIEW_MINIMUM
        && reviewRow.status === "preparing"
      ) {
        const result = await transaction.query(
          `UPDATE football_reviews
           SET status = 'preparation_failed', version = version + 1,
               updated_at = clock_timestamp()
           WHERE id = $1 AND owner_id = $2
           RETURNING *`,
          [reviewRow.id, ownerId],
        );
        updated = result.rows[0];
        await appendAudit(transaction, {
          reviewId: reviewRow.id,
          ownerId,
          eventType: "preview_preparation_failed",
          fromStatus: "preparing",
          toStatus: "preparation_failed",
          version: Number(updated.version),
          candidateId,
          reasonCode: input.errorCode || "RENDER_FAILED",
        });
      }
      return mapReview(updated, await this.loadCandidates(transaction, updated));
    });
  }

  async expirePreviews(input = {}) {
    const ownerId = validateResourceId(input.ownerId, "usr");
    return await this.withTransaction(async (transaction) => {
      const reviewRow = await this.loadOwnedReview(
        transaction,
        input.reviewId,
        ownerId,
        true,
      );
      const expired = await transaction.query(
        `UPDATE football_review_candidates
         SET preview_status = 'expired'
         WHERE review_id = $1
           AND owner_id = $2
           AND preview_status = 'ready'
           AND preview_expires_at <= clock_timestamp()
         RETURNING id, preview_artifact_id`,
        [reviewRow.id, ownerId],
      );
      for (const row of expired.rows) {
        if (!row.preview_artifact_id) continue;
        await transaction.query(
          `UPDATE artifacts
           SET status = 'delete_pending', updated_at = clock_timestamp()
           WHERE id = $1 AND owner_id = $2 AND status = 'available'`,
          [row.preview_artifact_id, ownerId],
        );
        await transaction.query(
          `INSERT INTO storage_operations(
             id, owner_id, artifact_id, operation, status, next_attempt_at
           )
           VALUES (
             $1, $2, $3, 'delete_object', 'queued', clock_timestamp()
           )`,
          [
            `sop_${this.randomUUID()}`,
            ownerId,
            row.preview_artifact_id,
          ],
        );
      }
      if (
        expired.rowCount
        && reviewRow.status === "pending"
      ) {
        const ready = await transaction.query(
          `SELECT count(*)::integer AS count
           FROM football_review_candidates
           WHERE review_id = $1
             AND owner_id = $2
             AND preview_status = 'ready'
             AND preview_expires_at > clock_timestamp()`,
          [reviewRow.id, ownerId],
        );
        if (Number(ready.rows[0].count) < READY_PREVIEW_MINIMUM) {
          const updated = await transaction.query(
            `UPDATE football_reviews
             SET status = 'preparing', version = version + 1,
                 updated_at = clock_timestamp()
             WHERE id = $1 AND owner_id = $2
             RETURNING *`,
            [reviewRow.id, ownerId],
          );
          return mapReview(
            updated.rows[0],
            await this.loadCandidates(transaction, updated.rows[0]),
          );
        }
      }
      return mapReview(
        reviewRow,
        await this.loadCandidates(transaction, reviewRow),
      );
    });
  }

  async decideAndEnqueueReview(input = {}) {
    const ownerId = validateResourceId(input.ownerId, "usr");
    const reviewId = validateReviewId(input.reviewId);
    const action = input.action === "reject_all" ? "reject" : String(input.action || "");
    if (!DECISION_ACTIONS.has(action)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    const expectedVersion = validateVersion(input.expectedVersion);
    const expectedSourceRevision = validateSourceRevision(
      input.expectedSourceRevision,
    );
    const candidateId = action === "select"
      ? validateCandidateId(input.candidateId)
      : null;
    const key = String(input.idempotencyKey || "");
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(key)) {
      throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400);
    }
    const requestHash = input.requestHash || decisionRequestHash({
      ...input,
      reviewId,
      expectedVersion,
      expectedSourceRevision,
      action,
      candidateId,
    });
    return await this.withTransaction(async (transaction) => {
      const reviewRow = await this.loadOwnedReview(
        transaction,
        reviewId,
        ownerId,
        true,
      );
      const reserved = await transaction.query(
        `INSERT INTO idempotency_records(
           owner_id, scope, key, request_hash, resource_type
         )
         VALUES ($1, 'football-review-decision', $2, $3, 'football_review_decision')
         ON CONFLICT (owner_id, scope, key) DO NOTHING
         RETURNING owner_id`,
        [ownerId, key, requestHash],
      );
      if (!reserved.rowCount) {
        const replay = await transaction.query(
          `SELECT request_hash, response_json
           FROM idempotency_records
           WHERE owner_id = $1
             AND scope = 'football-review-decision'
             AND key = $2
           FOR UPDATE`,
          [ownerId, key],
        );
        if (
          !replay.rowCount
          || String(replay.rows[0].request_hash).trim() !== requestHash
        ) {
          throw new AppError(
            "FOOTBALL_REVIEW_CONFLICT",
            SAFE_MESSAGES.FOOTBALL_REVIEW_CONFLICT,
            409,
          );
        }
        if (!replay.rows[0].response_json) {
          throw new AppError(
            "PROJECT_STATE_LOCKED",
            SAFE_MESSAGES.PROJECT_STATE_LOCKED,
            409,
          );
        }
        const response = json(replay.rows[0].response_json);
        const current = await this.loadOwnedReview(
          transaction,
          response.reviewId,
          ownerId,
        );
        return {
          review: mapReview(
            current,
            await this.loadCandidates(transaction, current),
          ),
          job: response.jobId
            ? mapJob((await transaction.query(
              "SELECT * FROM jobs WHERE id = $1 AND owner_id = $2",
              [response.jobId, ownerId],
            )).rows[0])
            : null,
          replayed: true,
        };
      }
      if (
        Number(reviewRow.version) !== expectedVersion
        || reviewRow.source_revision !== expectedSourceRevision
      ) {
        throw new AppError(
          "FOOTBALL_REVIEW_STALE",
          SAFE_MESSAGES.FOOTBALL_REVIEW_STALE,
          409,
        );
      }
      if (reviewRow.status !== "pending") {
        throw new AppError(
          "FOOTBALL_REVIEW_ALREADY_DECIDED",
          SAFE_MESSAGES.FOOTBALL_REVIEW_ALREADY_DECIDED,
          409,
        );
      }
      if (reviewRow.rights_confirmed !== true) {
        throw new AppError(
          "FOOTBALL_REVIEW_RIGHTS_REQUIRED",
          SAFE_MESSAGES.FOOTBALL_REVIEW_RIGHTS_REQUIRED,
          409,
        );
      }

      let selected = null;
      if (action === "select") {
        const ready = await transaction.query(
          `SELECT candidate.*, artifact.metadata_json
           FROM football_review_candidates AS candidate
           JOIN artifacts AS artifact
             ON artifact.id = candidate.preview_artifact_id
            AND artifact.owner_id = candidate.owner_id
            AND artifact.type = 'preview'
            AND artifact.status = 'available'
           WHERE candidate.review_id = $1
             AND candidate.owner_id = $2
             AND candidate.preview_status = 'ready'
             AND candidate.preview_expires_at > clock_timestamp()
           ORDER BY candidate.created_at, candidate.id`,
          [reviewId, ownerId],
        );
        if (ready.rowCount < READY_PREVIEW_MINIMUM) throw candidateInvalid();
        selected = ready.rows.find((row) => row.id === candidateId);
        if (!selected) throw candidateInvalid();
        const metadata = json(selected.metadata_json);
        const manifest = metadata.previewManifest || {};
        if (
          manifest.candidateId !== candidateId
          || manifest.sourceRevision !== reviewRow.source_revision
          || manifest.planHash !== String(selected.plan_hash).trim()
          || manifest.checksumSha256
            !== String(selected.preview_checksum_sha256 || "").trim()
        ) {
          throw candidateInvalid();
        }
      }

      let queued = null;
      if (action === "select") {
        queued = await this.jobQueue.enqueueInTransaction(transaction, {
          ownerId,
          projectId: reviewRow.project_id,
          uploadId: reviewRow.source_upload_id,
          action: "render_approved_candidate",
          pipelineType: "football",
          payload: {
            rightsConfirmed: true,
            approvedEditPlan: json(selected.edit_plan_json),
            footballReviewApproval: {
              reviewId,
              reviewVersion: expectedVersion,
              candidateId,
              sourceRevision: reviewRow.source_revision,
              planHash: String(selected.plan_hash).trim(),
            },
          },
          traceparent: input.traceparent || null,
        }, {
          idempotencyKey: `football-render-${reviewId}-${candidateId}`,
        });
      } else if (action === "regenerate") {
        queued = await this.jobQueue.enqueueInTransaction(transaction, {
          ownerId,
          projectId: reviewRow.project_id,
          uploadId: reviewRow.source_upload_id,
          action: "football_review_regenerate",
          pipelineType: "football",
          payload: {
            reviewId,
            sourceJobId: reviewRow.source_job_id,
            sourceRevision: reviewRow.source_revision,
          },
          traceparent: input.traceparent || null,
        }, {
          idempotencyKey: `football-regenerate-${reviewId}`,
        });
      }
      const toStatus = action === "select"
        ? "selected"
        : action === "regenerate"
          ? "regeneration_requested"
          : "rejected";
      const decisionId = `fdec_${this.randomUUID()}`;
      await transaction.query(
        `INSERT INTO football_review_decisions(
           id, review_id, owner_id, action, candidate_id, expected_version,
           expected_source_revision, request_hash, reviewer_note
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          decisionId,
          reviewId,
          ownerId,
          action,
          candidateId,
          expectedVersion,
          expectedSourceRevision,
          requestHash,
          input.reviewerNote || null,
        ],
      );
      const updatedResult = await transaction.query(
        `UPDATE football_reviews
         SET
           status = $3,
           selected_candidate_id = $4,
           render_job_id = $5,
           regeneration_job_id = $6,
           version = version + 1,
           updated_at = clock_timestamp()
         WHERE id = $1 AND owner_id = $2
         RETURNING *`,
        [
          reviewId,
          ownerId,
          toStatus,
          candidateId,
          action === "select" ? queued.job.id : null,
          action === "regenerate" ? queued.job.id : null,
        ],
      );
      const updated = updatedResult.rows[0];
      await appendAudit(transaction, {
        reviewId,
        ownerId,
        eventType: `review_${action}`,
        fromStatus: "pending",
        toStatus,
        version: Number(updated.version),
        candidateId,
        jobId: queued && queued.job.id,
      });
      const response = {
        reviewId,
        jobId: queued && queued.job.id || null,
        decisionId,
      };
      await transaction.query(
        `UPDATE idempotency_records
         SET resource_id = $4, response_json = $5::jsonb
         WHERE owner_id = $1
           AND scope = 'football-review-decision'
           AND key = $2
           AND request_hash = $3`,
        [ownerId, key, requestHash, decisionId, JSON.stringify(response)],
      );
      return {
        review: mapReview(
          updated,
          await this.loadCandidates(transaction, updated),
        ),
        job: queued && queued.job || null,
        replayed: false,
      };
    });
  }

  publicReview(review, previewOptions = new Map()) {
    return {
      schemaVersion: 2,
      id: review.id,
      projectId: review.projectId,
      sourceRevision: review.sourceRevision,
      projectRevision: review.projectRevision,
      version: review.version,
      status: review.status,
      selectedCandidateId: review.selectedCandidateId,
      candidates: review.candidates.map((candidate) => publicCandidate(
        candidate,
        previewOptions.get(candidate.id) || {},
      )),
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
    };
  }
}

module.exports = {
  PostgresFootballReviewRepository,
  READY_PREVIEW_MINIMUM,
  decisionRequestHash,
  mapCandidate,
  mapReview,
};
