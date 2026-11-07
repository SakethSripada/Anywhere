# Demo-only: a real Linux desktop streamed over VNC/WebSocket, same stack as
# production (Xvfb + x11vnc + websockify), with Blender and a scripted "agent".
FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive DISPLAY=:1
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc websockify xfce4 xfce4-terminal dbus-x11 xdotool x11-utils \
      blender python3 fonts-dejavu-core mousepad procps \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m demo
COPY start.sh agent.py /opt/
RUN chmod +x /opt/start.sh
USER demo
WORKDIR /home/demo
EXPOSE 6080 6090
CMD ["/opt/start.sh"]
