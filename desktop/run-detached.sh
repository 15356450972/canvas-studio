#!/bin/sh
# 从终端启动的 Electron 和那个终端属于同一个进程组：终端会话被回收（Cursor 窗口重载、标签关掉、
# 重启、或者同一终端里又跑了别的命令）时，整个进程组会收到 SIGTERM，应用就“自己停了”，
# 而且终端日志里看不到退出记录。这里把进程交给 launchd 托管，脱离终端生命周期。
#
# 用法：
#   ./run-detached.sh          启动（前端沿用已有构建产物）
#   ./run-detached.sh stop     停止
#   ./run-detached.sh status   查看状态
set -e

DIR=$(cd "$(dirname "$0")" && pwd)
BIN="$DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG="$HOME/Library/Logs/CanvasStudio.log"
LABEL="com.canvas.studio"

case "${1:-start}" in
    stop)
        launchctl remove "$LABEL" 2>/dev/null && echo "已停止" || echo "没有在运行"
        ;;
    status)
        if launchctl list "$LABEL" >/dev/null 2>&1; then
            echo "运行中：$(launchctl list "$LABEL" | awk -F'= ' '/"PID"/{gsub(/;/,"",$2);print $2}')"
        else
            echo "未运行"
        fi
        ;;
    start)
        if launchctl list "$LABEL" >/dev/null 2>&1; then
            echo "已经在运行，先执行 $0 stop 再启动"
            exit 0
        fi
        mkdir -p "$(dirname "$LOG")"
        : > /tmp/canvas-studio-launch.sh
        {
            echo "#!/bin/sh"
            echo "exec \"$BIN\" \"$DIR\" >> \"$LOG\" 2>&1"
        } > /tmp/canvas-studio-launch.sh
        chmod +x /tmp/canvas-studio-launch.sh
        launchctl submit -l "$LABEL" -- /bin/sh /tmp/canvas-studio-launch.sh
        sleep 2
        if launchctl list "$LABEL" >/dev/null 2>&1; then
            echo "已在后台启动（父进程是 launchd，不受终端关闭影响）"
            echo "应用日志：$LOG"
            echo "主进程日志：$HOME/Library/Application Support/Canvas Studio/main.log"
        else
            echo "启动失败，请看 $LOG"
            exit 1
        fi
        ;;
    *)
        echo "用法：$0 {start|stop|status}"
        exit 1
        ;;
esac
