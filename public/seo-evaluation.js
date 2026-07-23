(function (global) {
  "use strict";

  var VERSION = "seo_v3_verified_review_20260723";

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function compact(value) {
    return text(value).replace(/\s+/g, "").toLowerCase();
  }

  function optionalNumber(value) {
    if (value === null || value === undefined || text(value) === "") return null;
    var number = Number(String(value).replace(/[^0-9.]/g, ""));
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function formatNumber(value) {
    return Math.round(Number(value) || 0).toLocaleString("ko-KR");
  }

  function repeatedTitleWord(title, keyword) {
    var compactKeyword = compact(keyword);
    var compactTitle = compact(title);
    if (compactKeyword && compactTitle.split(compactKeyword).length - 1 > 2) return true;
    var counts = {};
    return text(title).split(/\s+/).filter(function (word) { return word.length > 1; }).some(function (word) {
      var key = word.toLowerCase();
      counts[key] = (counts[key] || 0) + 1;
      return counts[key] > 3;
    });
  }

  function categoryMatchesKeyword(category, keyword) {
    var compactCategory = compact(category);
    var compactKeyword = compact(keyword);
    if (!compactCategory || !compactKeyword) return false;
    if (compactCategory.includes(compactKeyword) || compactKeyword.includes(compactCategory)) return true;
    var tokens = text(keyword).split(/\s+/).map(compact).filter(function (token) { return token.length >= 2; });
    return tokens.length > 0 && tokens.every(function (token) { return compactCategory.includes(token); });
  }

  function grade(score, confidence) {
    if (confidence < 80) {
      return {
        label: "데이터 추가 필요",
        copy: "확인된 데이터가 부족합니다. 상품 정보·검색 시장·리뷰 근거가 모두 확인돼야 최종 판단할 수 있습니다."
      };
    }
    if (score >= 90) return { label: "A · 운영 강화", copy: "상품 등록 품질과 리뷰 신뢰 신호가 좋습니다. 현재 강점을 유지하면서 순위 변화를 추적하세요." };
    if (score >= 80) return { label: "B+ · 일부 보완", copy: "큰 문제는 없지만 낮은 항목을 보완하면 검색 노출 준비도가 더 안정적입니다." };
    if (score >= 70) return { label: "B · 보완 필요", copy: "기본 준비는 됐지만 상품 정보·검색 시장·리뷰 중 약한 항목을 먼저 개선해야 합니다." };
    if (score >= 55) return { label: "C · 수정 우선", copy: "상품 정보와 리뷰 신뢰도 중 여러 항목을 함께 보완해야 합니다." };
    return { label: "D · 재점검", copy: "상품명·카테고리·검색 시장·리뷰를 기본 단계부터 다시 점검해야 합니다." };
  }

  function actionText(key) {
    var actions = {
      title: "상품명 앞 10자 안에 핵심 키워드를 자연스럽게 배치하고 같은 단어의 과도한 반복을 줄이세요.",
      category: "상품과 일치하는 세부 카테고리·속성을 선택하고 기준 키워드와 상품군이 실제로 연결되는지 확인하세요.",
      market: "정확 월 검색량과 등록 상품 수를 확인해 주 키워드와 보조 키워드를 분리하세요.",
      review: "리뷰가 적으면 정책을 준수하는 구매 경험과 리뷰 관리로 신뢰 신호를 꾸준히 확보하세요."
    };
    return actions[key] || "확인되지 않았거나 점수가 낮은 항목부터 보완하세요.";
  }

  function evaluate(input) {
    input = input || {};
    var keyword = text(input.keyword);
    var title = text(input.title);
    var category = text(input.category);
    var productId = text(input.productId);
    var titleCompact = compact(title);
    var keywordCompact = compact(keyword);
    var keywordIndex = keywordCompact && titleCompact ? titleCompact.indexOf(keywordCompact) : -1;
    var titleLength = title.replace(/\s+/g, " ").trim().length;
    var repeated = repeatedTitleWord(title, keyword);
    var checks = [];

    function addCheck(key, titleText, detail, score, max, verified, source) {
      checks.push({
        key: key,
        title: titleText,
        detail: detail,
        score: Math.max(0, Math.min(max, Math.round(score || 0))),
        max: max,
        verified: Boolean(verified),
        source: source || (verified ? "자동 확인" : "확인 필요")
      });
    }

    var titleVerified = Boolean(title);
    var titleScore = 0;
    if (keywordIndex >= 0) titleScore += 13;
    if (keywordIndex >= 0 && keywordIndex <= 10) titleScore += 6;
    if (titleLength >= 18 && titleLength <= 65) titleScore += 6;
    if (title && !repeated) titleScore += 5;
    var titleDetail = titleVerified
      ? (keywordIndex >= 0
        ? "기준 키워드가 상품명 " + (keywordIndex + 1) + "번째 글자부터 확인됩니다."
        : "기준 키워드가 상품명에 보이지 않습니다.") + " 상품명 길이는 " + titleLength + "자입니다."
      : "상품 URL에서 정확한 상품명을 확인하지 못했습니다.";
    if (titleVerified && repeated) titleDetail += " 동일 키워드나 단어 반복이 많습니다.";
    addCheck("title", "상품명 SEO", titleDetail, titleScore, 30, titleVerified, "자동 확인");

    var categoryVerified = Boolean(category);
    var categoryDepth = category ? category.split(">").filter(Boolean).length : 0;
    var categoryMatch = categoryMatchesKeyword(category, keyword);
    var categoryScore = 0;
    if (categoryVerified) categoryScore += 5;
    if (categoryDepth >= 2) categoryScore += 4;
    if (productId) categoryScore += 3;
    if (categoryMatch) categoryScore += 8;
    var categoryDetail = categoryVerified
      ? "확인된 카테고리: " + category + ". " + (categoryMatch ? "기준 키워드와 상품군이 연결됩니다." : "기준 키워드와 세부 상품군 일치를 추가 확인해야 합니다.")
      : "상품 URL에서 카테고리를 확인하지 못했습니다.";
    addCheck("category", "카테고리·속성", categoryDetail, categoryScore, 20, categoryVerified, "자동 확인");

    var hasVolume = Boolean(input.hasVolume);
    var shoppingTotal = optionalNumber(input.shoppingTotal);
    var competitionLabel = text(input.competitionLabel || "확인 필요");
    var competitionKnown = competitionLabel && competitionLabel !== "확인 필요";
    var marketVerified = hasVolume || shoppingTotal !== null || competitionKnown;
    var marketScore = (hasVolume ? 12 : 0) + (shoppingTotal !== null ? 6 : 0) + (competitionKnown ? 7 : 0);
    var marketDetail = hasVolume ? "월 검색수 " + text(input.volumeText || "확인됨") + " 기준입니다." : "월 검색량을 확인하지 못했습니다.";
    if (shoppingTotal !== null) marketDetail += " 등록 상품은 약 " + formatNumber(shoppingTotal) + "개입니다.";
    if (competitionKnown) marketDetail += " 경쟁강도는 " + competitionLabel + "입니다.";
    addCheck("market", "검색 수요·경쟁", marketDetail, marketScore, 25, marketVerified, "자동 확인");

    var reviewCount = optionalNumber(input.reviewCount);
    var reviewVerified = reviewCount !== null;
    var reviewScore = 0;
    var reviewLabel = "미입력";
    if (reviewVerified) {
      if (reviewCount >= 1000) { reviewScore = 25; reviewLabel = "매우 강함"; }
      else if (reviewCount >= 300) { reviewScore = 20; reviewLabel = "강함"; }
      else if (reviewCount >= 100) { reviewScore = 16; reviewLabel = "양호"; }
      else if (reviewCount >= 20) { reviewScore = 10; reviewLabel = "성장"; }
      else if (reviewCount > 0) { reviewScore = 5; reviewLabel = "보완"; }
      else { reviewLabel = "리뷰 없음"; }
    }
    var reviewDetail = reviewVerified
      ? "직접 입력한 리뷰 " + formatNumber(reviewCount) + "개 기준이며 신뢰 신호는 " + reviewLabel + "입니다. 리뷰 수가 많을수록 신뢰 점수가 상승합니다."
      : "실제 리뷰 수를 입력하면 리뷰 신뢰 점수를 반영합니다.";
    addCheck("review", "리뷰 신뢰도", reviewDetail, reviewScore, 25, reviewVerified, reviewVerified ? "직접 입력" : "확인 필요");

    var verifiedChecks = checks.filter(function (check) { return check.verified; });
    var verifiedMax = verifiedChecks.reduce(function (sum, check) { return sum + check.max; }, 0);
    var earned = verifiedChecks.reduce(function (sum, check) { return sum + check.score; }, 0);
    var confidence = Math.round(verifiedMax);
    var score = verifiedMax ? Math.round((earned / verifiedMax) * 100) : 0;
    var actions = checks
      .filter(function (check) { return !check.verified || check.score / check.max < 0.75; })
      .sort(function (a, b) {
        var aGap = a.verified ? a.max - a.score : a.max;
        var bGap = b.verified ? b.max - b.score : b.max;
        return bGap - aGap;
      })
      .slice(0, 3)
      .map(function (check) {
        return {
          key: check.key,
          title: check.title,
          detail: actionText(check.key),
          score: check.score,
          max: check.max,
          verified: check.verified
        };
      });

    if (!actions.length) {
      actions = [{ key: "maintain", title: "유지 관리", detail: "현재 상품 등록 품질과 리뷰 신뢰 신호가 양호합니다. 순위와 리뷰 변화를 계속 확인하세요.", score: score, max: 100, verified: true }];
    }

    return {
      version: VERSION,
      score: Math.max(0, Math.min(100, score)),
      confidence: Math.max(0, Math.min(100, confidence)),
      grade: grade(score, confidence),
      checks: checks,
      actions: actions,
      reviewCount: reviewCount,
      reviewLabel: reviewLabel
    };
  }

  global.MomentSeoEvaluation = Object.freeze({
    version: VERSION,
    evaluate: evaluate,
    optionalNumber: optionalNumber
  });
}(typeof window !== "undefined" ? window : globalThis));
