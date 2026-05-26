(function(){
  document.querySelectorAll('video.hls-video[data-hls-src]').forEach(function(video){
    var src = video.getAttribute('data-hls-src');
    if (!src) return;
    if (window.Hls && window.Hls.isSupported()) {
      var hls = new Hls();
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else {
      var p = document.createElement('p');
      p.textContent = 'HLS video detected. Player library did not load.';
      video.parentNode.appendChild(p);
    }
  });
})();
