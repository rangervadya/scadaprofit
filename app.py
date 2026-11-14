"""Root-level compatibility launcher. Runs the backend/app.py server from project root."""
from pathlib import Path
import runpy
import sys

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))
runpy.run_path(str(BACKEND / "app.py"), run_name="__main__")
