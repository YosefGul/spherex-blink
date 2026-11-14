# SPHEREx Blink: FastAPI server + static front end in one container.
# AI-assisted (Claude Code).
FROM python:3.12-slim

# Run as an ordinary user (uid 1000, which some hosts require).
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    SPX_CACHE_DIR=/tmp/spx-cache
WORKDIR /home/user/app

COPY --chown=user requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

COPY --chown=user backend backend
COPY --chown=user frontend frontend
COPY --chown=user data/seed data/seed

# Hosts tell the container which port to listen on through $PORT; 7860 is the fallback.
EXPOSE 7860
CMD ["sh", "-c", "exec python -m uvicorn app:app --app-dir backend --host 0.0.0.0 --port ${PORT:-7860}"]
