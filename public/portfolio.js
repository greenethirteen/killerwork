document.querySelectorAll('[data-gallery]').forEach(function(gallery) {
  var track = gallery.querySelector('.gallery-track');
  var prev = gallery.querySelector('.gallery-prev');
  var next = gallery.querySelector('.gallery-next');
  if (!track || !prev || !next) return;

  function step(direction) {
    var amount = track.clientWidth * 0.92 * direction;
    track.scrollBy({ left: amount, behavior: 'smooth' });
  }

  prev.addEventListener('click', function() { step(-1); });
  next.addEventListener('click', function() { step(1); });
});
