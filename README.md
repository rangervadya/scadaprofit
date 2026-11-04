# CAD Reconstruction Engine 4.3.7

Version 4.3.7 improves topology-level classification of connected multi-branch line networks. It relaxes the old maximum-degree limit only for substantial, ink-supported, low-OCR networks (at least 8 edges, 2–7 branch nodes, length >=135 px, max degree <=8, controlled edge/turn density). It also prevents the generic dense-symbol veto from overriding connected/elbow route candidates that independently meet route, branch, ink and OCR checks.

Isolated long strokes, text-crossing components, dimension-like geometry, and weakly supported groups remain review-only. No endpoint candidate is auto-joined; crossings remain review-only. The UI reports topology-network candidates and how many of their edges entered PIPE_MAIN.

Retains the 45-minute Python timeout, streaming progress logs, persisted jobs and explicit user-confirmed joins from 4.3.6. The new route-network promotion is still a heuristic, not proof of engineering connectivity; verify the DXF against the source drawing before construction or installation. See `README-RU.md` and `INSTALL-4.3.7-RU.md`.
