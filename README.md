
# ReYohoho Twitch 1080p/1440p Proxy
🚀 UPD 09.10.2025 1440p теперь доступен с расширением, при условии поддержки кодека H.265 в браузере.

⚠️ Расширение передаёт ваш OAuth-twitch токен на наш бэкенд. Это необходимо для отстуствия рекламной заглушки и работы 1440p качества.

⚠️ UPD 07.10.2025 проксировать usher.ttvnw.net уже недостаточно, решается получением токена PlaybackAccessToken через gql.twitch.. на стороне бэкенда и там же запрос к usher используя данные полученного токена. результат возвращаем клиенту как плейлист. 
Если вы используете свой прокси для обхода ограничений, то добавьте gql.twitch.tv в список проксирования

Twitch в РФ ограничил 1080P качество видео, есть способы обхода(VPN/proxy адреса usher.ttvnw.net и gql.twitch.tv)

Расширение перенаправляет запросы к usher.ttvnw.net через наш прокси, обеспечивая доступ к качеству 1080p/1440p для российских пользователей.

- **Chromium** (Chrome, Яндекс.Браузер, Opera и др.)  
  🔹 [Основное расширение](https://chromewebstore.google.com/detail/reyohoho-twitch-proxy/ohgphcndclpcmbglhldmnagagdbmkoef?authuser=0&hl=ru)  
  🔹 [Альтернатива (при ошибке 2000)](https://chromewebstore.google.com/detail/twitch-enhanced-viewer/pnhhdhhcadcjfckjhpmjneldiegbojfb)  
  ⚠️ Используйте только одно расширение одновременно!

- **Firefox**  
  🔹 [Расширение для Firefox](https://addons.mozilla.org/ru/firefox/addon/reyohoho-twitch-proxy)

- **Метод для всех браузеров, поддерживающих Tampermonkey**  
 1. Установить [Tampermonkey](https://www.tampermonkey.net/)
 2. Включите в браузере режим [разработчика](https://www.tampermonkey.net/faq.php?locale=en#Q209)
 3. Перейти по [ссылке](https://github.com/reyohoho/twitch_quality_proxy/raw/refs/heads/universal/dist/userscript/reyohoho-twitch.user.js) откроется окно с предложением установить скрипт
   
Так же важно:
 - ⚠️ Отключите альтернативный плеер твича или подобное, с ним может не работать
 - ⚠️ Если ошибка 2000
   то отключите WARP если используете или пробуйте расширение TTV LOL PRO или альтернативное
 - ⚠️ Расширение не проксирует сами потоки стримов,
   поэтому не влияет на их работу(например если подлагивает стрим)

### Поддержкать:
 Telegram: [https://t.me/send?start=IV7outCFI5B0](https://t.me/send?start=IV7outCFI5B0)  
 USDT (TRON – TRC20):  
`TYH7kvPryhSCFWjdRVw68VZ1advYaZw3yJ`
