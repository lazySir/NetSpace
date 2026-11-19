# NetSpace Windows 验证记录

验证日期：2026-11-19。Windows x64 本机验证，目标为 Windows 10 / 11 x64。

- 29 项 Python 单元测试通过，涵盖网络范围、设备证据、网卡别名、退出取消、本机服务与接口保护。
- 主浏览器检查 10 项通过：设备与详情、搜索、演示隔离、标记导出、接口切换、视角控制、375px布局、减少动画偏好、离线资源。截图使用虚构测试数据。
- 4 项恢复检查通过：断网后重新读取接口、扫描中重新打开、其他页面占用扫描、409后扫描已经完成的竞争。
- 独立复核通过。
- 已打包 NetSpace.exe。移除 PATH 中的 Python 后启动成品成功；页面与3D资源逐字节匹配源码。
- 成品重复启动复用同端口实例；真实地址解析完成，发现3个设备节点、2条推断连线；其中1个本机在线，2个地址已解析（不声称在线），耗时19.0秒，无采集警告。
- 成品退出成功，进程正常结束。

可复现命令：

```text
python -m unittest discover -s tests -v
node tools/ui_smoke.cjs
node tools/ui_recovery.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1
python tools/packaged_smoke.py
```

浏览器检查需要在 .tools/qa 安装 Playwright，并启动本地服务；它们模拟API，不触发真实网络扫描。成品检查会对本机已连接的第一个IPv4接口执行真实发现。依赖仅用于开发验证，不是运行成品所需。

已知边界：仅发现本机网络可见的IPv4设备；地址解析可能来自缓存；连线为同网段推断；位置为模拟布局。较大网段限制主动范围并在界面提示。默认端口被其他程序占用时采用随机端口，重复启动可能产生独立实例（见README）。
