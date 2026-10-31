# BV1Td4y1578E — neovim 配置教程（字幕车道首战,2026-11-01）

- URL: https://www.bilibili.com/video/BV1Td4y1578E/（22.9 min,单 P）
- 路径: auto → subtitle（511 cues,秒回,未动 ASR）
- 质量: 连贯可读,内容与标题相符(可直接采用,无需回退 ASR)

## 本战发现(负结果/机器事实,全部已修入 hear.py)

1. **B站字幕登录才可见**: 匿名只有弹幕(danmaku xml);必须 --cookies
   (配置 cookiesFile → ~/secrets/bilibili-cookies.txt)
2. **AI字幕语言代码是 `ai-zh`,格式 srt**,不是猜想的 zh-Hans/vtt
3. **B站把 AI 字幕挂在"普通字幕"下**: 要 `--write-subs` 才拉得到,
   `--write-auto-subs` 单用报 "no subtitles"(YouTube 类相反)——
   现在双旗全开通吃两类平台
4. srt 与 vtt 解析同构(时间戳正则已兼容逗号毫秒),cue 序号行被跳过

## 质量判读(前200字)

术语渲染不稳: "neovim" → "new vim"(0:03) / "neo vim"(0:25)——与
sensevoice(coded review)/whisper(拍抗台湾)同族的转写术语弱点,
跨引擎共享,校对仍不可省。正文流畅度高于预期,断句细(短语级 cue)。

## 回归判据

换 yt-dlp 版本或重构 subtitle 车道后重打此 URL:登录态下必须拿到
ai-zh;匿名态必须优雅报 reason 而非崩溃;auto 不应在有字幕时误回退 ASR。
