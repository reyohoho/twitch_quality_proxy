
# ReYohoho Twitch 1080p Proxy
 ⚠️ UPD 07.10.2025 проксировать usher.ttvnw.net уже недостаточно, решается получением токена PlaybackAccessToken через gql.twitch.. на стороне бэкенда и там же запрос к usher используя данные полученного токена. результат возвращаем клиенту как плейлист.
 Если вы используете свой прокси для обхода ограничений, то добавьте gql.twitch.tv в список проксирования

Twitch в РФ ограничил 1080P качество видео, есть способы обхода(VPN/proxy адреса usher.ttvnw.net)

Расширение перенаправляет запросы к usher.ttvnw.net через наш прокси, обеспечивая доступ к качеству 1080p для российских пользователей.

⚠ 1440p не поддерживается без VPN! Для просмотра в этом качестве потребуется VPN/прокси в регионе, где оно доступно.

- **Chromium** (Chrome, Яндекс.Браузер, Opera и др.)  
  🔹 [Основное расширение](https://chromewebstore.google.com/detail/reyohoho-twitch-proxy/ohgphcndclpcmbglhldmnagagdbmkoef?authuser=0&hl=ru)  
  🔹 [Альтернатива (при ошибке 2000)](https://chromewebstore.google.com/detail/twitch-enhanced-viewer/pnhhdhhcadcjfckjhpmjneldiegbojfb)  
  ⚠️ Используйте только одно расширение одновременно!

- **Firefox**  
  🔹 [Расширение для Firefox](https://addons.mozilla.org/ru/firefox/addon/reyohoho-twitch-proxy)

- **Метод для всех браузеров, поддерживающих Tampermonkey**  
 1. Установить [Tampermonkey](https://www.tampermonkey.net/)
 2. Включите в браузере режим [разработчика](https://www.tampermonkey.net/faq.php?locale=en#Q209)
 3. Перейти по [ссылке](https://github.com/reyohoho/twitch_quality_proxy/raw/refs/heads/userscript/twitch.user.js) откроется окно с предложением установить скрипт
   
Так же важно:
 - ⚠️ Отключите альтернативный плеер твича или подобное, с ним может не работать
 - ⚠️ Если ошибка 2000
   то отключите WARP если используете или пробуйте расширение TTV LOL PRO или альтернативное
 - ⚠️ Расширение не проксирует сами потоки стримов,
   поэтому не влияет на их работу(например если подлагивает стрим)
 - Некоторый стримеры из РФ могут запросить возможность стримить в 2к на
   твиче, тогда 1080 будет доступно в РФ(но не 2к), но из-за этого
   уменьшится битрейт в 1080(например с 8к до 6к + увеличится нагрузка
   на OBS/GPU)
 - Так же всем советуют расширение TTV LOL PRO, но с ним может появиться реклама в РФ, можно использовать и этот вариант, если наш не заработает.
   

### Поддержкать:
 Telegram: [https://t.me/send?start=IV7outCFI5B0](https://t.me/send?start=IV7outCFI5B0)  
 USDT (TRON – TRC20):  
`TYH7kvPryhSCFWjdRVw68VZ1advYaZw3yJ`
