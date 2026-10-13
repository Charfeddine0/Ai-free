"""Desktop launcher — تطبيق حاسوب حقيقي: يشغّل البوابة + يفتح المتصفح + أيقونة درج.
Usage: python desktop/launcher.py  (or the built exe)
"""
from __future__ import annotations

import os
import threading
import time
import webbrowser

HOST = os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("PORT", "8080"))


def _serve():
    import uvicorn
    from app.main import app
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")


def main():
    t = threading.Thread(target=_serve, daemon=True)
    t.start()
    time.sleep(2.5)
    url = f"http://{HOST}:{PORT}"
    print(f"✅ Ai-Free يعمل الآن على {url}")
    print("📂 البيانات في ./data/ai_free.db")
    try:
        webbrowser.open(url)
    except Exception as e:
        print("تعذر فتح المتصفح تلقائياً:", e)
    try:
        # system tray (optional)
        import pystray
        from PIL import Image, ImageDraw

        def _icon():
            img = Image.new("RGB", (64, 64), (20, 40, 90))
            d = ImageDraw.Draw(img)
            d.ellipse([12, 12, 52, 52], fill=(90, 162, 255))
            return img

        def _open(icon, item):
            webbrowser.open(url)

        def _quit(icon, item):
            icon.stop()
            os._exit(0)

        pystray.Icon("Ai-Free", _icon(), "Ai-Free Gateway",
                     menu=pystray.Menu(pystray.MenuItem("فتح الواجهة", _open),
                                       pystray.MenuItem("خروج", _quit))).run()
    except Exception:
        print("اضغط Ctrl+C للإيقاف.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
