# Chrome Web Store Listing

## 基础信息

- 名称：公众号边听边读
- GitHub repo：wechat-article-tts
- 单一用途：在微信公众号文章页提供本地语音听读、逐句高亮、自动滚动和阅读进度恢复。
- 非官方声明：本扩展不是微信或腾讯官方产品，也未获得微信或腾讯背书。

## 短描述

边听边读微信公众号文章，逐句高亮当前内容，自动滚动并支持断点续读。本地语音，不上传文章内容。

## 详细描述

公众号边听边读是一款面向微信公众号重度读者的 Chrome 扩展。打开公众号文章后，它会在原页面识别正文，使用 Chrome/系统内置语音朗读，并同步高亮当前句、自动滚动到正在听读的位置。

适合在通勤、整理资料、做家务或长文阅读时使用：你可以听文章，也可以随时看回原文上下文。

主要功能：

- 公众号文章正文听读。
- 当前句逐句高亮。
- 自动滚动到正在朗读的位置。
- 页面底部轻量播放器。
- 开始、暂停、继续、上一句、下一句。
- 拖动进度条跳转到指定句子。
- 选中正文后从当前位置开始朗读后文。
- 自动保存语速和阅读进度。
- 使用浏览器本地语音，不接云端 TTS API。
- 只适配 `mp.weixin.qq.com` 公众号文章页。

隐私与权限：

公众号边听边读不上传文章正文，不使用远程代码，也不会把文章内容发送给开发者或第三方服务器。语速和阅读进度仅保存在浏览器本地。

本扩展不是微信或腾讯官方产品，也未获得微信或腾讯背书。

## 关键词

公众号边听边读、公众号听读、公众号朗读、微信公众号朗读、公众号文章朗读、文章朗读器、逐句高亮、自动滚动、Chrome TTS、wechat article tts

## 权限说明

- `activeTab`：在用户当前打开的公众号文章页执行听读操作。
- `scripting`：在公众号文章页注入正文识别、高亮和播放器脚本。
- `storage`：本地保存语速和阅读进度。
- `tts`：调用 Chrome/系统内置语音朗读。
- `https://mp.weixin.qq.com/*`：只在微信公众号文章页读取正文并显示播放器。

## 隐私字段建议

- Remote code：No，不使用远程代码。
- Data use：不向开发者或第三方服务器收集、传输、出售或分享用户数据。
- 如果 Dashboard 要求披露可访问的数据类型，说明扩展会在本地处理当前公众号文章页面内容，仅用于朗读、高亮和进度恢复。
- Privacy policy URL：指向 GitHub 仓库中的 `PRIVACY.md`，或发布后的独立隐私页面。

## 视觉素材清单

- 扩展图标：`icons/wechat-article-tts-icon-128.png`
- 截图 1：`store-assets/screenshots/screenshot-1-main-player.png`
- 截图 2：`store-assets/screenshots/screenshot-2-popup-controls.png`
- 截图 3：`store-assets/screenshots/screenshot-3-selection-reading.png`
- 小宣传图：`store-assets/promotional/small-promo-440x280.png`

正式文章截图源文件固定放在：

- `store-assets/source/authorized-article-main-player.png`
- `store-assets/source/authorized-article-popup.png`
- `store-assets/source/authorized-article-selection.png`

这些源图必须由文章权利方或项目维护者授权公开使用。不要自动化绕过 `mp.weixin.qq.com` 页面限制抓取截图。

## 发布包建议

Chrome Web Store 上传包只包含扩展运行文件和图标：

```bash
mkdir -p dist
zip -r dist/wechat-article-tts-0.2.1.zip \
  manifest.json background.js contentScript.js contentStyle.css \
  popup.html popup.js popup.css icons
```

不要把 `.git`、`.DS_Store`、`store-assets/`、草稿文档或本地路径放进上传包。

## 测试说明

1. 打开一篇 `https://mp.weixin.qq.com/` 公众号文章。
2. 点击工具栏扩展图标，确认 popup 显示准备态和句子进度。
3. 点击“开始”，确认朗读、逐句高亮和自动滚动正常。
4. 测试暂停、继续、上一句、下一句、拖动进度和语速切换。
5. 选中正文文字，点击“从这里读”，确认播放器定位到该句并继续朗读后文。
6. 刷新同一篇文章，确认语速和阅读进度可恢复。
7. 打开非公众号页面，确认扩展提示“请切换到微信公众号文章页”。
8. 更新扩展后，刷新已经打开的公众号文章页，确认新脚本和样式生效。

## 中文社区发布帖草稿

我做了一个 Chrome 扩展「公众号边听边读」：打开微信公众号文章后，可以边听边读，当前句会逐句高亮并自动滚动。它使用 Chrome/系统内置语音，不接云端 TTS API，也不会上传文章内容。

适合读长文、通勤听文章、整理资料时使用。当前版本只适配 `mp.weixin.qq.com`，功能包括底部播放器、从这里读、进度跳转、语速调节和断点续读。

GitHub：wechat-article-tts
