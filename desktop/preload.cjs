// 网页里的 HTML5 拖拽只能带文本/URL，拖到剪映这类桌面应用时对方拿不到文件；
// 系统级文件拖拽必须由主进程调用 webContents.startDrag 发起，所以这里只开一个最小桥。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("canvasDesktop", {
    // 渲染进程负责把媒体取成 ArrayBuffer，主进程落盘后立刻开始拖拽。
    dragFile: (name, buffer) => ipcRenderer.send("canvas:drag-file", { name, buffer }),
});
