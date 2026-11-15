"""ScadaProfit CAD reconstruction engine.

Modules are grouped by responsibility:
  core     - geometry primitives, vector/centerline preprocessing, logging,
             analysis deadline, reference tracing
  ocr      - local Qwen3-VL client and image preprocessing
  model    - document model, clean layout, validation, diagnostics, templates
  export   - CAD/SVG/DXF/PDF export, graph, topology
  symbols  - symbol catalog, recognition, channel splitting, annotation linking

processor.py is the CLI entry point: python -m engine.processor
"""
