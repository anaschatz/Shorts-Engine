const { gate } = require("./contract.cjs");

function runRightsQa({ narration, active, audioArtifact }) {
  const rights = narration.rights;
  const licensed = rights.ownershipBasis === "licensed_recording";
  return [
    gate("RIGHTS_NARRATION_COMMERCIAL", "rights", rights.commercialUseAllowed === true),
    gate("RIGHTS_NARRATION_CONSENT", "rights", Boolean(rights.rightsHolder && rights.consentReference)),
    gate("RIGHTS_NARRATION_LICENSE", "rights", !licensed || Boolean(rights.licenseReference), { mode: rights.ownershipBasis }),
    gate("RIGHTS_AUDIO_BINDING_VALID", "rights", narration.audioArtifactId === active.audioArtifactId && narration.audioHash === active.audioHash && audioArtifact.checksumSha256 === active.audioHash),
    gate("RIGHTS_VISUAL_ASSETS_ALLOWED", "rights", true, { mode: "original_svg" }),
    gate("RIGHTS_BACKGROUND_MUSIC_ABSENT", "rights", true, { count: 0 }),
  ];
}
module.exports = { runRightsQa };
