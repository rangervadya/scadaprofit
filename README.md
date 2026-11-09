# ScadaProfit 4.3.42 — CAD quality gating and source-safe preview

## Исправление 4.3.42: недопустимые координаты Qwen

Qwen PIPE теперь проверяет каждую точку относительно точной ширины и высоты изображения, отправленного в Ollama. Маршрут с координатами за пределами фрагмента отклоняется целиком; точки больше не обрезаются до границы исходной страницы. Это устраняет ложные граничные линии от ответов вроде `y=4800` для фрагмента высотой 480 px.

Подпись checkpoint изменена, поэтому старые сохранённые Qwen PIPE-ответы с прежней логикой проверки не переиспользуются. Диагностика показывает размеры фрагмента, диапазон неправильных координат и количество отклонённых маршрутов.

Дополнительно усилена защита ориентации: один лишь небольшой перевес OCR-оценки не может автоматически перевернуть технический чертёж на 180 градусов. По умолчанию для такого поворота требуется относительный перевес 35% (`OSD_FALLBACK_180_MIN_MARGIN`).


This release corrects the misleading default preview introduced by the raw centreline trace mode. Source-ink skeletonization includes every dark stroke on the page: pipe lines, letters, dimensions, leaders, symbols and scanning noise. It is an inspection/vector-trace artifact, not a semantically classified pipe network.

## Result viewer changes

- The result panel now opens on **Исходник** (the exact uploaded image) by default.
- The automatic CAD preview is selected only when topology, symbol classification and dimension attachment pass conservative readiness checks.
- When checks fail, the page shows the original without distortion and lists the measured reasons. The CAD draft remains manually inspectable, but clean SVG/DXF/PDF export from the failed CAD draft is disabled.
- Raw linework modes are explicitly named **Все штрихи** and **Контуры штрихов** and remain available for technical inspection; they are not described as a clean pipe drawing.
- PDF printing from the original view prints the source image; SVG/DXF are disabled in that mode because an image is not a vector CAD result.

## CAD readiness checks

The readiness assessment flags excessive open endpoints, high crossing density, insufficient symbol classification and insufficient dimension-to-object attachment. For the user's current diagnostic these values fail: 406 open endpoints / 428 segments, 173 crossings / 428 segments, 0/11 classified symbols and 1/8 attached dimensions. Therefore ScadaProfit should not present the generated CAD draft as a finished drawing.

The machine-readable diagnostics now include `cadReadiness` with `ready`, `automaticCadExportAllowed`, `failedChecks` and metrics. Existing source-trace artifacts remain exportable for review. The diagnostic job status continues to distinguish processing completion from engineering readiness.

## Recognition stack and other applications

Local Qwen-VL via Ollama and Tesseract (`rus+eng`) remain unchanged. This release does not stop or reconfigure Ollama, other Python/GPU processes, other applications, VDGO, PostgreSQL, Nginx/gateway, Docker volumes, Compose configuration or the user's `.env`.

Deploy through GitHub and rebuild only ScadaProfit's `app` service:

```bash
git pull --ff-only
docker compose build app
docker compose up -d --no-deps app
```

Run checks with `npm run check`.

## Important limitation

This release prevents raw pixel skeletons from being presented as a clean engineering drawing. It does not itself solve semantic recognition of all pipes, valves, meters, dimensions and connections. The current source photo still requires improved symbol classification, geometry grouping and engineer review before a true clean CAD reconstruction can be claimed.