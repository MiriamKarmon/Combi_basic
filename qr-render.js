/* QR rendering for combi-quiz. Uses the local qrcode-generator library (qrcode.min.js).
   Everything runs in the page - the room code is never sent to any external service. */
'use strict';
window.CombiQr = {
  /* Draws `text` as a QR code on a new canvas inside container. Returns true on success. */
  draw: function (container, text) {
    if (typeof qrcode === 'undefined') return false;
    container.innerHTML = '';
    var qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var cell = 6, margin = 4;
    var size = (n + margin * 2) * cell;
    var cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#241a3a';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + margin) * cell, (r + margin) * cell, cell, cell);
      }
    }
    cv.style.width = '216px';
    cv.style.height = '216px';
    cv.style.imageRendering = 'pixelated';
    cv.style.display = 'block';
    cv.setAttribute('aria-label', 'QR code');
    container.appendChild(cv);
    return true;
  }
};
