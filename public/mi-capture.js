// 전체 캡처(대표 요청 2026-09-08): 키워드 조회 화면 전체를 "캡처본 느낌"의 이미지(PNG, 아주 길면 JPG)로 저장한다.
// html2canvas 1.4.1(MIT)을 /vendor 에 자체 호스팅해 두고, 버튼을 눌렀을 때만 읽어 온다(CSP script-src 'self' 유지).
// 공개 페이지가 아니라 로그인 안쪽 화면에서만 쓰며, 서버로는 아무것도 보내지 않는다.
(function () {
  var VENDOR_URL = "/vendor/html2canvas.min.js?v=1.4.1";
  var MAX_SIDE = 16000; // 브라우저 캔버스 한 변 상한(크롬·사파리 16384) 아래로
  var JPEG_AREA = 12000000; // 이보다 크면 PNG 대신 JPG(파일 크기)
  var loading = null;

  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = VENDOR_URL;
      script.async = true;
      script.onload = function () {
        if (window.html2canvas) resolve(window.html2canvas);
        else reject(new Error("html2canvas missing after load"));
      };
      script.onerror = function () {
        loading = null;
        reject(new Error("html2canvas load failed"));
      };
      document.head.appendChild(script);
    });
    return loading;
  }

  function download(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // element 를 통째로 그려 Blob 으로 돌려준다(내려받지 않음). options: { background, ignore(node) → true 면 제외,
  //   captureCss: 복제본에만 넣는 CSS(예: html2canvas 가 못 그리는 calc() 격자선 그라데이션을 끄기), onclone(doc),
  //   windowWidth: 복제 문서의 창 너비(고정 폭 시트를 데스크톱 배치로 그릴 때 1400 등), fileBase }
  // N30 순위 공유 이미지(2026-09-09)가 이 함수를 쓴다 — foreignObject 캔버스가 사파리·아이폰에서 오염돼 SVG 로 떨어지던 문제의 대체 경로.
  window.miCaptureElementBlob = async function (element, options) {
    options = options || {};
    var html2canvas = await loadHtml2Canvas();
    var height = Math.max(1, element.scrollHeight || element.getBoundingClientRect().height || 1);
    var width = Math.max(1, element.scrollWidth || element.getBoundingClientRect().width || 1);
    var scale = Math.max(1, Math.min(2, Math.floor((MAX_SIDE / Math.max(height, width)) * 10) / 10));
    var windowWidth = Number(options.windowWidth) > 0 ? Number(options.windowWidth) : document.documentElement.clientWidth;
    var canvas = await html2canvas(element, {
      scale: scale,
      backgroundColor: options.background || null,
      useCORS: true,
      logging: false,
      scrollX: 0,
      scrollY: -window.scrollY,
      windowWidth: windowWidth,
      ignoreElements: function (node) {
        try { return Boolean(options.ignore && options.ignore(node)); } catch (error) { return false; }
      },
      onclone: function (clonedDocument) {
        try {
          if (options.captureCss) {
            var style = clonedDocument.createElement("style");
            style.textContent = String(options.captureCss);
            clonedDocument.head.appendChild(style);
          }
          if (typeof options.onclone === "function") options.onclone(clonedDocument);
        } catch (error) {}
      }
    });
    var jpeg = canvas.width * canvas.height > JPEG_AREA;
    var blob = await new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (result) {
          if (result) resolve(result);
          else reject(new Error("image export failed"));
        }, jpeg ? "image/jpeg" : "image/png", 0.92);
      } catch (error) {
        reject(error);
      }
    });
    var fileName = (options.fileBase || "capture") + (jpeg ? ".jpg" : ".png");
    return { blob: blob, fileName: fileName, bytes: blob.size, width: canvas.width, height: canvas.height, scale: scale, jpeg: jpeg, ext: jpeg ? "jpg" : "png" };
  };

  // 그려서 바로 내려받는다(키워드 조회 "데이터 캡처" 버튼이 쓴다).
  window.miCaptureElement = async function (element, options) {
    var result = await window.miCaptureElementBlob(element, options);
    download(result.blob, result.fileName);
    return result;
  };
})();
