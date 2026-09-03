#!/bin/bash
# ==============================================================================
# Linux VPS Google BBR 拥塞控制与跨洋高丢包优化脚本
# 作用：在服务器端启用 Google BBR 算法与 FQ 队列，极大改善跨洋丢包与首包卡顿
# ==============================================================================

set -e

echo "============================================================"
echo "      VPS 网络内核优化：Google BBR & TCP 性能调优"
echo "============================================================"

# 1. 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
  echo "[-] 请使用 root 权限执行此脚本（例如: sudo bash enable-vps-bbr.sh）"
  exit 1
fi

# 2. 检查系统内核版本
kernel_version=$(uname -r | cut -d- -f1)
kernel_major=$(echo "$kernel_version" | cut -d. -f1)
kernel_minor=$(echo "$kernel_version" | cut -d. -f2)

echo "[*] 当前系统内核版本: $kernel_version"
if [ "$kernel_major" -lt 4 ] || ([ "$kernel_major" -eq 4 ] && [ "$kernel_minor" -lt 9 ]); then
  echo "[-] 内核版本低于 4.9，不支持原生 BBR 模块。请先升级内核。"
  exit 1
fi

# 3. 加载 BBR 模块
echo "[*] 加载 tcp_bbr 内核模块..."
modprobe tcp_bbr || true

# 4. 配置 sysctl.conf
echo "[*] 写入高性能 TCP 内核参数至 /etc/sysctl.conf..."
SYSCTL_FILE="/etc/sysctl.conf"

# 移除旧的拥塞控制配置
sed -i '/net.core.default_qdisc/d' "$SYSCTL_FILE"
sed -i '/net.ipv4.tcp_congestion_control/d' "$SYSCTL_FILE"
sed -i '/net.ipv4.tcp_slow_start_after_idle/d' "$SYSCTL_FILE"
sed -i '/net.ipv4.tcp_window_scaling/d' "$SYSCTL_FILE"

# 追加优化参数
cat >> "$SYSCTL_FILE" <<EOF

# --- AI Proxy & Cross-Border BBR Optimizations ---
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_window_scaling = 1
net.ipv4.tcp_slow_start_after_idle = 0
EOF

# 5. 应用配置生效
echo "[*] 执行 sysctl -p 生效参数..."
sysctl -p > /dev/null 2>&1 || sysctl --system > /dev/null 2>&1

# 6. 验证 BBR 是否成功运行
current_cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo "unknown")
current_qdisc=$(sysctl -n net.core.default_qdisc 2>/dev/null || echo "unknown")

echo ""
echo "============================================================"
if [ "$current_cc" = "bbr" ]; then
  echo "  ✅ 恭喜！Google BBR 算法已成功开启！"
  echo "  当前队列调度算法 (qdisc): $current_qdisc"
  echo "  当前拥塞控制算法 (cc)   : $current_cc"
  echo "  在 20%~30% 跨洋高丢包环境下，吞吐量将显著提升！"
else
  echo "  ⚠️ 当前算法状态: $current_cc (预期: bbr)"
  echo "  请检查内核模块或重启服务器以完成生效。"
fi
echo "============================================================"

