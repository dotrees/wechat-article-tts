# Store Assets

Chrome Web Store 上架素材。

## Files

- `screenshots/screenshot-1-main-player.png`：1280x800
- `screenshots/screenshot-2-popup-controls.png`：1280x800
- `screenshots/screenshot-3-selection-reading.png`：1280x800
- `promotional/small-promo-440x280.png`：440x280

SVG 源文件与 PNG 同目录保存，便于后续修改文案或构图。

## Authorized Article Sources

如果要使用正式公众号文章截图，请先手动提供已授权可公开使用的源图：

- `source/authorized-article-main-player.png`
- `source/authorized-article-popup.png`
- `source/authorized-article-selection.png`

当前仓库不会自动化抓取 `mp.weixin.qq.com` 页面，也不会把未授权文章内容伪装成公开商店截图。

## Regenerate

```bash
rsvg-convert -w 1280 -h 800 store-assets/screenshots/screenshot-1-main-player.svg -o store-assets/screenshots/screenshot-1-main-player.png
rsvg-convert -w 1280 -h 800 store-assets/screenshots/screenshot-2-popup-controls.svg -o store-assets/screenshots/screenshot-2-popup-controls.png
rsvg-convert -w 1280 -h 800 store-assets/screenshots/screenshot-3-selection-reading.svg -o store-assets/screenshots/screenshot-3-selection-reading.png
rsvg-convert -w 440 -h 280 store-assets/promotional/small-promo-440x280.svg -o store-assets/promotional/small-promo-440x280.png
```
