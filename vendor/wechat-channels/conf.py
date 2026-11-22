from pathlib import Path

# The worker runs in a private per-job directory for upstream diagnostic images.
BASE_DIR = Path(".")
LOCAL_CHROME_HEADLESS = False
LOCAL_CHROME_PATH = None
DEBUG_MODE = False
