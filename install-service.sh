#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="openclaw-viewer"
SYSTEMD_DIR="${HOME}/.config/systemd/user"

mkdir -p "${SYSTEMD_DIR}"

sed "s|%h/openclaw-chat-viewer|${SCRIPT_DIR}|g" \
  "${SCRIPT_DIR}/${SERVICE_NAME}.service" > "${SYSTEMD_DIR}/${SERVICE_NAME}.service"

echo "Installed ${SERVICE_NAME}.service to ${SYSTEMD_DIR}/"
echo ""
echo "Configure the admin password:"
echo "  systemctl --user edit ${SERVICE_NAME}"
echo "  # Add: [Service]"
echo "  # Environment=OPENCLAW_ADMIN_PASSWORD=your-password"
echo ""
echo "Then enable and start:"
echo "  systemctl --user daemon-reload"
echo "  systemctl --user enable --now ${SERVICE_NAME}"
echo "  systemctl --user status ${SERVICE_NAME}"
echo "  journalctl --user -u ${SERVICE_NAME} -f"
