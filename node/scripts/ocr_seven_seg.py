#!/usr/bin/env python3
"""
OCR for BP monitors / scales — phone photos.
Reads image from argv[1], prints JSON to stdout.
Tries tesseract (primary) + ssocr (fallback).
"""
import sys
import json
import subprocess
import tempfile
import os
import re

def parse_bp(text):
    """Extract systolic/diastolic/pulse from OCR text."""
    # Find all 2-3 digit numbers
    nums = re.findall(r'\b(\d{2,3})\b', text)
    nums = [int(n) for n in nums if 30 <= int(n) <= 250]
    result = {}
    if len(nums) >= 1: result['systolic'] = nums[0]
    if len(nums) >= 2: result['diastolic'] = nums[1]
    if len(nums) >= 3: result['pulse'] = nums[2]
    return result

def preprocess(image_path):
    """Return list of (label, path) preprocessed variants."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return [("raw", image_path)]

    img = cv2.imread(image_path)
    if img is None:
        return [("raw", image_path)]

    variants = []
    # Upscale
    h, w = img.shape[:2]
    if max(h, w) < 1200:
        s = 1200 / max(h, w)
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_CUBIC)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Variant 1: CLAHE + otsu
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    _, otsu = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    tmp1 = tempfile.mktemp(suffix='_v1.png')
    cv2.imwrite(tmp1, otsu)
    variants.append(("clahe-otsu", tmp1))

    # Variant 2: inverted otsu (light digits on dark)
    tmp2 = tempfile.mktemp(suffix='_v2.png')
    cv2.imwrite(tmp2, cv2.bitwise_not(otsu))
    variants.append(("clahe-otsu-inv", tmp2))

    # Variant 3: adaptive threshold
    adap = cv2.adaptiveThreshold(enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                  cv2.THRESH_BINARY, 31, 10)
    tmp3 = tempfile.mktemp(suffix='_v3.png')
    cv2.imwrite(tmp3, adap)
    variants.append(("adaptive", tmp3))

    # Variant 4: just enhanced grayscale (let tesseract handle it)
    tmp4 = tempfile.mktemp(suffix='_v4.png')
    cv2.imwrite(tmp4, enhanced)
    variants.append(("enhanced", tmp4))

    return variants

def run_tesseract(path, psm=6):
    """Run tesseract with digit whitelist."""
    try:
        r = subprocess.run(
            ['tesseract', path, '-', '-l', 'eng', '--psm', str(psm),
             '-c', 'tessedit_char_whitelist=0123456789 /'],
            capture_output=True, text=True, timeout=15
        )
        return r.stdout.strip()
    except Exception:
        return ""

def run_ssocr(path):
    for preset in [['-d', '-1', '-T', '-s'], ['-d', '-1', '-T', '-s', 'invert']]:
        try:
            r = subprocess.run(['ssocr'] + preset + [path],
                               capture_output=True, text=True, timeout=10)
            txt = r.stdout.strip()
            if txt and any(c.isdigit() for c in txt):
                return txt
        except Exception:
            continue
    return ""

def main(image_path):
    variants = preprocess(image_path)
    best = None
    attempts = []
    for label, path in variants:
        for psm in [6, 11, 7, 12]:
            text = run_tesseract(path, psm=psm)
            if text:
                values = parse_bp(text)
                attempts.append({"engine": f"tess-{label}-psm{psm}", "text": text, "values": values})
                # A good result has at least 2 numbers in BP range
                if len(values) >= 2:
                    best = attempts[-1]
                    break
        if best:
            break
        # Also try ssocr on preprocessed variant
        txt = run_ssocr(path)
        if txt:
            values = parse_bp(txt)
            attempts.append({"engine": f"ssocr-{label}", "text": txt, "values": values})
            if len(values) >= 2:
                best = attempts[-1]
                break
    # Cleanup temp files
    for _, p in variants:
        if p != image_path:
            try: os.unlink(p)
            except: pass

    if best:
        return {"ok": True, "text": best["text"], "values": best["values"], "engine": best["engine"]}
    # Return most promising attempt even if incomplete
    if attempts:
        best = max(attempts, key=lambda a: len(a.get("values", {})))
        return {"ok": False, "text": best["text"], "values": best["values"],
                "engine": best["engine"], "error": "could not extract BP triple"}
    return {"ok": False, "error": "no OCR output"}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "usage: ocr_seven_seg.py <image>"}))
        sys.exit(1)
    try:
        print(json.dumps(main(sys.argv[1])))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
