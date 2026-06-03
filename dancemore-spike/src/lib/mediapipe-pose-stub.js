// Stub for @mediapipe/pose.
//
// @tensorflow-models/pose-detection statically imports `Pose` from
// "@mediapipe/pose" at the top of its ESM barrel, but that package ships a UMD
// bundle with no ESM exports, so Turbopack fails the build on the missing
// named export. We only use the MoveNet model via the tfjs runtime, which never
// touches the MediaPipe runtime, so an empty placeholder is safe.
export class Pose {}
export default Pose;
