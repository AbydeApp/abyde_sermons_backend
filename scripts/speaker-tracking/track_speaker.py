#!/usr/bin/env python3
"""Speaker tracking for Reel smart crop (MediaPipe face detection + OpenCV).

Contract (consumed by CommandSpeakerTracker):
  track_speaker.py --video PATH --start SECONDS --end SECONDS --fps N
  stdout: {"samples": [{"t": seconds_from_start, "cx": 0..1, "confidence": 0..1}, ...]}
  exit code 0 on success; anything else makes the worker fall back to a centre crop.

The speaker is chosen per frame as the face with the best mix of size, detection score and
closeness to the previous choice, so a face in the front row or a brief cutaway does not steal the
frame. Smoothing happens in the worker (crop planner), not here.

Requires: pip install -r requirements.txt  (Python 3.9–3.12; MediaPipe has no wheels for newer).
"""
import argparse
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--start", type=float, required=True)
    parser.add_argument("--end", type=float, required=True)
    parser.add_argument("--fps", type=float, default=2.0)
    args = parser.parse_args()

    import cv2  # noqa: PLC0415 (imported late so --help works without dependencies)
    import mediapipe as mp  # noqa: PLC0415

    capture = cv2.VideoCapture(args.video)
    if not capture.isOpened():
        print("cannot open video", file=sys.stderr)
        return 2

    samples = []
    previous_cx = None
    step = 1.0 / max(0.25, min(args.fps, 10.0))
    detector = mp.solutions.face_detection.FaceDetection(
        model_selection=1,  # full-range model: preachers are often far from the camera
        min_detection_confidence=0.4,
    )
    try:
        t = args.start
        while t <= args.end:
            capture.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
            ok, frame = capture.read()
            if not ok:
                break
            result = detector.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            best = None
            best_score = -1.0
            for detection in result.detections or []:
                box = detection.location_data.relative_bounding_box
                cx = min(1.0, max(0.0, box.xmin + box.width / 2.0))
                score = float(detection.score[0]) if detection.score else 0.0
                area = max(0.0, box.width * box.height)
                continuity = 1.0 if previous_cx is None else 1.0 - min(1.0, abs(cx - previous_cx) * 2.0)
                weighted = score * (0.5 + area * 20.0) * (0.6 + 0.4 * continuity)
                if weighted > best_score:
                    best_score = weighted
                    best = (cx, score)
            if best is not None:
                previous_cx = best[0]
                samples.append({"t": round(t - args.start, 3), "cx": round(best[0], 4), "confidence": round(best[1], 3)})
            t += step
    finally:
        detector.close()
        capture.release()

    json.dump({"samples": samples}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
