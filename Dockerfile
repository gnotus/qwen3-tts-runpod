ARG VLLM_OMNI_IMAGE=vllm/vllm-omni:v0.28.0-x86_64
FROM ${VLLM_OMNI_IMAGE}

WORKDIR /opt/qwen3-tts
COPY gateway.py start.sh ./
RUN chmod 0555 /opt/qwen3-tts/start.sh

ENV MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-Base \
    PORT=8000 \
    PORT_HEALTH=8000 \
    VLLM_PORT=8091

EXPOSE 8000
CMD ["/opt/qwen3-tts/start.sh"]
