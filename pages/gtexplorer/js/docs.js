(function () {
  var bg = document.querySelector('.parallax-bg');
  if (bg) {
    window.addEventListener('scroll', function () {
      bg.style.backgroundPosition = 'center ' + (window.pageYOffset * -0.15) + 'px';
    }, { passive: true });
  }
})();
