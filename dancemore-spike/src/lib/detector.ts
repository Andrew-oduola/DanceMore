import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-converter";
import "@tensorflow/tfjs-backend-webgl";
import "@tensorflow/tfjs-backend-cpu";
import * as poseDetection from "@tensorflow-models/pose-detection";

// Self-hosted copy of MoveNet SinglePose Lightning (v4) under public/models,
// so the app doesn't depend on tfhub.dev at runtime (faster, works offline).
const LOCAL_MODEL_URL = "/models/movenet-lightning/model.json";

// One place that knows how to stand up MoveNet (webgl, tfjs runtime).
// Used by the live-webcam hook and the upload-video extractor.
// Falls back to the (slow) CPU backend when WebGL isn't usable — e.g. very
// old GPUs or software-rendered environments — instead of failing outright.
export async function createMoveNetDetector(): Promise<poseDetection.PoseDetector> {
  const webglOk = await tf.setBackend("webgl").catch(() => false);
  if (!webglOk) await tf.setBackend("cpu");
  await tf.ready();
  const modelType = poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING;
  try {
    return await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType, modelUrl: LOCAL_MODEL_URL }
    );
  } catch {
    // Local copy missing/corrupt — fall back to the hosted model.
    return poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, {
      modelType,
    });
  }
}
