# Установка CAD Reconstruction Engine 4.3.7 через GitHub

## 1. На компьютере
1. Распакуйте архив `cad-sketch-converter-docker-4.3.7.zip`.
2. Скопируйте **содержимое** папки проекта поверх своей рабочей папки репозитория.
3. Не удаляйте и не заменяйте `.git` и `.env`. В архиве нет персонального `.env` и истории Git.
4. Выполните `npm run check` (если Node.js и Python установлены локально).
5. Загрузите изменения в GitHub в ветку `main`.

## 2. На сервере
В каталоге проекта `/opt/scadaprofit` выполните:

```bash
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
curl -sS http://127.0.0.1:3001/api/health
```

В ответе ожидается `"version":"4.3.7"`. Сервис Ollama не пересоздаётся, поскольку используется `--no-deps app`.

## 3. Хранение результатов
Версия 4.3.6 и последующие используют named volume `cad_jobs`, смонтированный в `/data/cad-reconstruction-jobs`. Обновление 4.3.6 → 4.3.7 не требует переноса `/tmp`-заданий. Не выполняйте `sudo docker compose down -v`: команда удалит тома Docker. Сохраните `.env` и репозиторий `.git`.

Если `git pull` сообщает `Permission denied` на файлах репозитория, проверьте владельца каталога. Для обычного пользователя `tech` можно один раз выполнить:

```bash
sudo chown -R "$(id -un):$(id -gn)" /opt/scadaprofit
```

## 4. Что проверять после обновления
В новом задании статистика `graph.json.summary` должна включать:
- `topology_network_candidate_components` — число многоветвевых компонентов, прошедших новый критерий;
- `topology_network_primary_edges` — сколько их рёбер попало в `PIPE_MAIN`;
- `structured_route_components` — число компонентов, прошедших независимые connected/elbow/network критерии.

Проверьте `PIPE_MAIN` и `DETAIL_REVIEW` на исходном чертеже. Новый критерий намеренно не переносит все сильные одиночные линии в `PIPE_MAIN`; размерные линии, текст и изолированные штрихи должны оставаться на проверке. Убедитесь, что соединения и пересечения соответствуют исходнику до использования DXF для монтажа или изготовления.
