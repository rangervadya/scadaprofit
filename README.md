# Two Mask Lab 3.5.0

Offline OpenCV + Tesseract tool for splitting pen strokes into text and line masks, cleaning handwritten text with OCR boxes/lasso, and exporting SVG centerline paths with editable typeset labels.

3.5 adds conservative endpoint joining: tiny raster gaps up to 4 px can be joined when both local directions align; longer gaps (up to 24 px) can only be joined when the missing segment lies mostly inside an OCR/lasso-removed text region. This is a vectorization-only operation; original binary masks are never modified.

For neat straight digits, remove the handwriting with lasso, enter the checked number, and enable typeset rendering. OCR guesses are not auto-printed because handwritten number recognition is unreliable.

See `UPDATE-RU.md`.
