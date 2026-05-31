(function () {
  var style = document.createElement('style');
  style.textContent = [
    '.media.image{position:relative;min-height:72px}',
    '.media-image-loader{position:absolute;inset:0;z-index:2;display:grid;place-items:center;background:rgba(11,11,15,.82);transition:opacity .2s ease,visibility .2s ease}',
    '.media-image-loader:before{content:"";width:34px;height:34px;border-radius:999px;border:3px solid rgba(255,255,255,.2);border-top-color:#7bdff2;border-right-color:#ffd166;animation:portfolio-image-spin .8s linear infinite}',
    '.media.image.is-loaded .media-image-loader{opacity:0;visibility:hidden;pointer-events:none}',
    '.behance-site .site-header,.behance-project .site-header{align-items:flex-start;padding:28px 4vw 22px}',
    '.behance-site .site-header .brand,.behance-project .site-header .brand{font-size:clamp(34px,5vw,74px);line-height:.94;letter-spacing:-.06em}',
    '.behance-site .site-header nav,.behance-project .site-header nav{padding-top:9px}',
    '@media(max-width:650px){.behance-site .site-header,.behance-project .site-header{padding:22px 18px 14px}.behance-site .site-header .brand,.behance-project .site-header .brand{font-size:clamp(32px,10vw,52px)}.behance-site .site-header nav,.behance-project .site-header nav{padding-top:5px}}',
    '@keyframes portfolio-image-spin{to{transform:rotate(360deg)}}'
  ].join('');
  document.head.appendChild(style);

  document.querySelectorAll('.media.image').forEach(function (figure) {
    var image = figure.querySelector('img');
    if (!image || figure.querySelector('.media-image-loader')) return;
    var loader = document.createElement('span');
    loader.className = 'media-image-loader';
    loader.setAttribute('aria-hidden', 'true');
    figure.insertBefore(loader, image);
    var done = function () { figure.classList.add('is-loaded'); };
    if (image.complete) done();
    else {
      image.addEventListener('load', done, { once: true });
      image.addEventListener('error', done, { once: true });
    }
  });
})();
