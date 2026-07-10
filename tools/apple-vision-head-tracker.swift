import AppKit
import Foundation
import Vision

struct FrameInput: Decodable {
  let id: String
  let time: Double
  let path: String
}

struct Payload: Decodable {
  let frames: [FrameInput]
}

func json(_ value: Any) {
  guard let data = try? JSONSerialization.data(withJSONObject: value) else {
    FileHandle.standardOutput.write(Data("{\"ok\":false}".utf8))
    return
  }
  FileHandle.standardOutput.write(data)
}

guard CommandLine.arguments.count == 2,
      let payloadData = CommandLine.arguments[1].data(using: .utf8),
      let payload = try? JSONDecoder().decode(Payload.self, from: payloadData) else {
  json(["ok": false, "code": "APPLE_VISION_INPUT_INVALID"])
  exit(0)
}

var rows: [[String: Any]] = []
for frame in payload.frames.prefix(16) {
  guard let image = NSImage(contentsOfFile: frame.path),
        let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    rows.append(["id": frame.id, "time": frame.time, "faces": []])
    continue
  }
  let request = VNDetectFaceRectanglesRequest()
  request.usesCPUOnly = true
  let humanRequest = VNDetectHumanRectanglesRequest()
  humanRequest.upperBodyOnly = false
  humanRequest.usesCPUOnly = true
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  do {
    try handler.perform([request, humanRequest])
    let faces = (request.results ?? []).prefix(12).map { face in
      [
        "x": face.boundingBox.origin.x,
        "y": face.boundingBox.origin.y,
        "width": face.boundingBox.width,
        "height": face.boundingBox.height,
        "confidence": face.confidence,
      ] as [String: Any]
    }
    let humans = (humanRequest.results ?? []).prefix(12).map { person in
      [
        "x": person.boundingBox.origin.x,
        "y": person.boundingBox.origin.y,
        "width": person.boundingBox.width,
        "height": person.boundingBox.height,
        "confidence": person.confidence,
      ] as [String: Any]
    }
    rows.append(["id": frame.id, "time": frame.time, "faces": faces, "humans": humans])
  } catch {
    rows.append(["id": frame.id, "time": frame.time, "faces": [], "humans": []])
  }
}

json(["ok": true, "frames": rows])
