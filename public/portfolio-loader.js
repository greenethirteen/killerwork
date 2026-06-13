(function () {
  var style = document.createElement('style');
  style.textContent = [
    '.media.image{position:relative;min-height:72px}',
    '.source-exact-image-frame{position:relative}',
    '.media-image-loader{position:absolute;inset:0;z-index:2;display:grid;place-items:center;background:rgba(11,11,15,.82);transition:opacity .2s ease,visibility .2s ease}',
    '.media-image-loader:before{content:"";width:34px;height:34px;border-radius:999px;border:3px solid rgba(255,255,255,.2);border-top-color:#7bdff2;border-right-color:#ffd166;animation:portfolio-image-spin .8s linear infinite}',
    '.media.image.is-loaded .media-image-loader,.source-exact-image-frame.is-loaded>.media-image-loader{opacity:0;visibility:hidden;pointer-events:none}',
    '.behance-site .site-header,.behance-project .site-header{align-items:flex-start;padding:28px 4vw 22px}',
    '.behance-site .site-header .brand,.behance-project .site-header .brand{font-size:clamp(34px,5vw,74px);line-height:.94;letter-spacing:-.06em}',
    '.behance-site .site-header nav,.behance-project .site-header nav{padding-top:9px}',
    '.behance-site .home{padding-top:26px}.behance-site .behance-home .work-grid{margin-top:18px}',
    '.behance-project .project-meta,.behance-project .project-meta div:first-child,.behance-project .source-note,.behance-project .campaign-title-split small{color:var(--fg)}',
    '@media(max-width:650px){.behance-site .site-header,.behance-project .site-header{padding:22px 18px 14px}.behance-site .site-header .brand,.behance-project .site-header .brand{font-size:clamp(32px,10vw,52px)}.behance-site .site-header nav,.behance-project .site-header nav{padding-top:5px}}',
    '@keyframes portfolio-image-spin{to{transform:rotate(360deg)}}'
  ].join('');
  document.head.appendChild(style);

  if (document.body.classList.contains('behance-project')) {
    var background = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) || [];
    var channels = background.slice(0, 3).map(Number);
    if (channels.length === 3) {
      var luminance = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1000;
      var isLight = luminance >= 160;
      document.body.style.setProperty('--fg', isLight ? '#111111' : '#ffffff');
      document.body.style.setProperty('--muted', isLight ? '#111111' : '#ffffff');
      document.body.style.setProperty('--line', isLight ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.18)');
    }
  }

  function attachImageLoader(frame, image) {
    if (!frame || !image || frame.querySelector(':scope > .media-image-loader')) return;
    var loader = document.createElement('span');
    loader.className = 'media-image-loader';
    loader.setAttribute('aria-hidden', 'true');
    frame.insertBefore(loader, frame.firstChild);
    var done = function () { frame.classList.add('is-loaded'); };
    if (image.complete) done();
    else {
      image.addEventListener('load', done, { once: true });
      image.addEventListener('error', done, { once: true });
    }
  }

  document.querySelectorAll('.media.image').forEach(function (figure) {
    attachImageLoader(figure, figure.querySelector('img'));
  });

  document.querySelectorAll('.source-exact-page img,.source-home-page img').forEach(function (image, index) {
    image.loading = index < 2 ? 'eager' : 'lazy';
    image.decoding = 'async';
    if (index >= 2) image.removeAttribute('fetchpriority');
    var picture = image.closest('picture');
    var frame = picture ? picture.parentElement : image.parentElement;
    if (!frame) return;
    frame.classList.add('source-exact-image-frame');
    attachImageLoader(frame, image);
  });

  document.querySelectorAll('.source-exact-page iframe,.source-home-page iframe').forEach(function (frame) {
    frame.loading = 'lazy';
  });

  document.querySelectorAll('.source-exact-page video,.source-home-page video').forEach(function (video) {
    if (!video.preload) video.preload = 'metadata';
  });

  // Page transitions — intercept same-origin link clicks and animate out
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.href;
    if (!href || a.target === '_blank' || a.getAttribute('href') === '#' ||
        href.indexOf('javascript') === 0 ||
        (href.indexOf('//') !== -1 && href.indexOf(location.host) === -1)) return;
    e.preventDefault();
    document.body.classList.add('page-leaving');
    var dest = href;
    setTimeout(function() { location.href = dest; }, 300);
  });
})();
