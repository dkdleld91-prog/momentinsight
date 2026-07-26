(function (global) {
  "use strict";

  var VERSION = "seo_v13_uniform_keyword_policy_20260726";
  var POLICY_ID = "uniform_keyword_evidence_v1";

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

  function normalizedTokens(value) {
    return text(value)
      .toLowerCase()
      .replace(/[^0-9a-zA-Z가-힣]+/g, " ")
      .split(/\s+/)
      .filter(function (token) { return token.length >= 2; });
  }

  function titleQualityState(title) {
    var counts = {};
    normalizedTokens(title).forEach(function (token) {
      counts[token] = (counts[token] || 0) + 1;
    });
    var duplicates = Object.keys(counts).filter(function (token) { return counts[token] > 1; });
    var promotional = [
      "무료배송", "최저가", "특가", "할인", "이벤트", "사은품", "증정", "쿠폰", "오늘만", "한정"
    ].filter(function (word) { return compact(title).includes(compact(word)); });
    var decorated = /[★☆♥♡◆◇■□●○▶▷✓✔※]{2,}/.test(title);
    var issueCount = duplicates.length + promotional.length + (decorated ? 1 : 0);
    return {
      score: issueCount === 0 ? 5 : (issueCount === 1 ? 2 : 0),
      duplicates: duplicates,
      promotional: promotional,
      decorated: decorated,
      issueCount: issueCount
    };
  }

  function categoryLeaf(value) {
    var parts = text(value).split(/[>\/]/).map(text).filter(Boolean);
    return compact(parts.length ? parts[parts.length - 1] : value);
  }

  function categoryBenchmarkState(category, peerCategories) {
    var targetLeaf = categoryLeaf(category);
    var peers = (Array.isArray(peerCategories) ? peerCategories : []).map(text).filter(Boolean).slice(0, 5);
    if (!targetLeaf || peers.length < 2) return null;
    var matched = peers.filter(function (peer) {
      return categoryLeaf(peer) === targetLeaf;
    }).length;
    var ratio = matched / peers.length;
    return {
      verified: true,
      category: text(category),
      sampleSize: peers.length,
      matched: matched,
      ratio: ratio,
      score: ratio >= 0.8 ? 15 : (ratio >= 0.6 ? 11 : (ratio >= 0.4 ? 7 : (ratio > 0 ? 3 : 0))),
      max: 15,
      label: ratio >= 0.8 ? "일치" : (ratio >= 0.6 ? "대체로 일치" : (ratio > 0 ? "일부 불일치" : "불일치"))
    };
  }

  function topKeywordBenchmarkState(title, peerTitles, keyword, brand, maker) {
    var peers = (Array.isArray(peerTitles) ? peerTitles : []).map(text).filter(Boolean).slice(0, 5);
    if (!title || peers.length < 2) return null;
    var excluded = {};
    normalizedTokens([keyword, brand, maker].join(" ")).forEach(function (token) {
      excluded[token] = true;
    });
    ["공식", "정품", "무료배송", "최저가", "추천", "세트", "상품"].forEach(function (token) {
      excluded[token] = true;
    });
    var counts = {};
    peers.forEach(function (peerTitle) {
      var seen = {};
      normalizedTokens(peerTitle).forEach(function (token) {
        if (excluded[token] || seen[token]) return;
        seen[token] = true;
        counts[token] = (counts[token] || 0) + 1;
      });
    });
    var minimum = Math.max(2, Math.ceil(peers.length * 0.6));
    var common = Object.keys(counts)
      .filter(function (token) { return counts[token] >= minimum; })
      .sort(function (left, right) {
        if (counts[right] !== counts[left]) return counts[right] - counts[left];
        return left.localeCompare(right, "ko");
      })
      .slice(0, 5);
    var targetTokens = {};
    normalizedTokens(title).forEach(function (token) { targetTokens[token] = true; });
    var matched = common.filter(function (token) { return targetTokens[token]; });
    var ratio = common.length ? matched.length / common.length : 1;
    var score = ratio >= 1 ? 10 : (ratio >= 0.75 ? 8 : (ratio >= 0.4 ? 6 : (ratio > 0 ? 3 : 0)));
    return {
      verified: true,
      sampleSize: peers.length,
      common: common,
      matched: matched,
      ratio: ratio,
      score: score,
      max: 10,
      label: !common.length ? "추가 공통어 없음" : (ratio >= 1 ? "충분" : (ratio >= 0.4 ? "일부 반영" : "보완"))
    };
  }

  function keywordMatchState(keyword, title, categoryBenchmark, topKeywordBenchmark) {
    var keywordCompact = compact(keyword);
    var titleCompact = compact(title);
    var exact = Boolean(keywordCompact && titleCompact.includes(keywordCompact));
    if (exact) return { exact: true, related: true, score: 10, level: "exact" };

    var keywordTokens = normalizedTokens(keyword);
    var titleTokens = normalizedTokens(title);
    var titleTokenMap = {};
    titleTokens.forEach(function (token) { titleTokenMap[token] = true; });
    var matchedKeywordTokens = keywordTokens.filter(function (token) { return titleTokenMap[token]; });
    var tokenRatio = keywordTokens.length ? matchedKeywordTokens.length / keywordTokens.length : 0;
    var containedTitleTokens = titleTokens.filter(function (token) {
      return token.length >= 2 && keywordCompact.includes(token);
    });
    var categoryRelated = Boolean(categoryBenchmark && categoryBenchmark.ratio >= 0.8);
    var marketRelated = Boolean(topKeywordBenchmark && topKeywordBenchmark.matched.length >= 2);
    var contextualRelated = categoryRelated && (marketRelated || containedTitleTokens.length > 0);
    var score = tokenRatio >= 0.75 ? 8 : (tokenRatio >= 0.5 || contextualRelated ? 6 : (tokenRatio > 0 || containedTitleTokens.length > 0 ? 3 : 0));
    return {
      exact: false,
      related: score >= 6,
      score: score,
      level: score >= 6 ? "related" : (score > 0 ? "weak" : "missing")
    };
  }

  function grade(score) {
    if (score >= 95) return { label: "A+ · 상위권 준비", copy: "핵심 등록 항목과 오가닉 노출 상태가 양호합니다. 이 점수는 검색 순위를 보장하지 않습니다." };
    if (score >= 90) return { label: "A · 등록 품질 양호", copy: "핵심 등록 항목은 양호하며 현재 순위 구간에 맞는 트래픽 운영이 필요합니다." };
    if (score >= 85) return { label: "B+ · 트래픽 보완", copy: "등록 항목이 양호하다면 검색 유입·클릭·판매 반응을 우선 보완하세요." };
    if (score >= 70) return { label: "B · 보완 필요", copy: "상품명·카테고리·리뷰 중 확인된 약한 항목을 먼저 개선해야 합니다." };
    if (score >= 55) return { label: "C · 수정 우선", copy: "상품 등록 품질의 기본 항목 여러 개를 함께 보완해야 합니다." };
    return { label: "D · 재점검", copy: "상품 등록 품질 기준을 처음부터 다시 점검해야 합니다." };
  }

  function actionText(key) {
    var actions = {
      titleFit: "기준 키워드를 자연스럽게 포함하고, 중복·홍보 문구를 덜어 상품명을 50자 이내로 정리하세요.",
      topKeywordFit: "상위 오가닉 상품명에서 반복되는 핵심어 중 실제 상품과 관련된 표현을 상품명에 자연스럽게 반영하세요.",
      categoryFit: "상위 오가닉 상품과 동일한 세부 카테고리를 사용하세요.",
      brandMaker: "브랜드와 제조사 정보를 정확하게 등록하세요.",
      imageReady: "대표 이미지를 등록하고 네이버 쇼핑 결과에서 정상 노출되는지 확인하세요.",
      reviewManual: "현재 리뷰 수량을 정확히 입력하고 리뷰 확보 계획을 보완하세요.",
      traffic: "검색 유입·클릭·판매 반응을 만드는 트래픽 운영을 보완하세요."
    };
    return actions[key] || "점수가 낮은 항목부터 보완하세요.";
  }

  function evaluate(input) {
    input = input || {};
    var keyword = text(input.keyword);
    var title = text(input.title);
    var keywordIncluded = Boolean(compact(keyword) && compact(title).includes(compact(keyword)));
    var titleLength = title.replace(/\s+/g, " ").trim().length;
    var checks = [];

    function addCheck(key, titleText, detail, score, max, verified, source) {
      if (!verified) return;
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

    var categoryBenchmark = categoryBenchmarkState(input.category, input.peerCategories);
    var brand = text(input.brand);
    var maker = text(input.maker);
    var topKeywordBenchmark = topKeywordBenchmarkState(title, input.peerTitles, keyword, brand, maker);
    var keywordMatch = keywordMatchState(keyword, title, categoryBenchmark, topKeywordBenchmark);
    var titleQuality = titleQualityState(title);
    var titleDetail = keywordMatch.exact
      ? "기준 키워드 포함"
      : (keywordMatch.related ? "기준 키워드 직접 미포함 · 상품군 관련성 확인" : "기준 키워드 미포함");
    titleDetail += " · " + titleLength + "자" + (titleLength <= 50 ? "로 권장 범위" : "로 50자 초과");
    if (titleQuality.issueCount) {
      var titleIssues = [];
      if (titleQuality.duplicates.length) titleIssues.push("반복 단어 " + titleQuality.duplicates.join(", "));
      if (titleQuality.promotional.length) titleIssues.push("홍보 문구 " + titleQuality.promotional.join(", "));
      if (titleQuality.decorated) titleIssues.push("과도한 장식 기호");
      titleDetail += " · " + titleIssues.join(" · ") + " 확인";
    } else {
      titleDetail += " · 중복·홍보 문구 없음";
    }
    addCheck(
      "titleFit",
      "상품명 적합도",
      titleDetail,
      keywordMatch.score + (titleLength <= 50 ? 5 : 0) + titleQuality.score,
      20,
      Boolean(title && keyword),
      "공식 상품명 자동 분석"
    );

    addCheck(
      "topKeywordFit",
      "상위 상품 핵심어",
      topKeywordBenchmark
        ? (topKeywordBenchmark.common.length
          ? "상위 " + topKeywordBenchmark.sampleSize + "개 공통어 " + topKeywordBenchmark.common.join(", ") +
            " 중 " + topKeywordBenchmark.matched.length + "개 반영"
          : "상위 " + topKeywordBenchmark.sampleSize + "개에서 추가 공통 핵심어가 형성되지 않았습니다.")
        : "",
      topKeywordBenchmark ? topKeywordBenchmark.score : 0,
      10,
      Boolean(topKeywordBenchmark),
      "상위 오가닉 상품명 자동 비교"
    );
    addCheck(
      "categoryFit",
      "카테고리 적합도",
      categoryBenchmark
        ? "세부 카테고리 " + categoryBenchmark.label +
          " (상위 " + categoryBenchmark.sampleSize + "개 중 " + categoryBenchmark.matched + "개)"
        : "",
      categoryBenchmark ? categoryBenchmark.score : 0,
      15,
      Boolean(categoryBenchmark),
      "상위 오가닉 카테고리 자동 비교"
    );

    var productInfoVerified = input.productInfoVerified === true;
    var brandMakerScore = (brand ? 7 : 0) + (maker ? 3 : 0);
    addCheck(
      "brandMaker",
      "브랜드·제조사",
      (brand ? "브랜드 " + brand : "브랜드 미등록") + " · " +
        (maker ? "제조사 " + maker : "제조사 미등록"),
      brandMakerScore,
      10,
      productInfoVerified,
      "공식 상품정보 자동 확인"
    );

    var image = text(input.image);
    var imageRegistered = /^https:\/\//i.test(image);
    addCheck(
      "imageReady",
      "대표 이미지",
      imageRegistered ? "네이버 쇼핑 결과에 대표 이미지가 정상 등록되어 있습니다." : "네이버 쇼핑 결과에서 대표 이미지를 확인하지 못했습니다.",
      imageRegistered ? 10 : 0,
      10,
      productInfoVerified,
      "공식 상품 이미지 자동 확인"
    );

    var reviewCount = optionalNumber(input.reviewCount);
    var reviewVerified = reviewCount !== null;
    var reviewLabel = "";
    var reviewScore = 0;
    if (reviewVerified) {
      if (reviewCount >= 1000) { reviewLabel = "매우 강함"; reviewScore = 20; }
      else if (reviewCount >= 300) { reviewLabel = "강함"; reviewScore = 17; }
      else if (reviewCount >= 100) { reviewLabel = "양호"; reviewScore = 14; }
      else if (reviewCount >= 20) { reviewLabel = "성장"; reviewScore = 10; }
      else if (reviewCount > 0) { reviewLabel = "보완"; reviewScore = 5; }
      else { reviewLabel = "리뷰 없음"; }
    }
    addCheck(
      "reviewManual",
      "리뷰 수량",
      reviewVerified ? "직접 입력한 리뷰 " + formatNumber(reviewCount) + "개 기준 · " + reviewLabel : "",
      reviewScore,
      20,
      reviewVerified,
      "직접 입력"
    );

    var rank = optionalNumber(input.rank);
    var rankCheckedCount = optionalNumber(input.rankCheckedCount);
    var rankVerified = rank !== null || (rank === null && rankCheckedCount !== null && rankCheckedCount >= 300);
    var trafficScore = 0;
    var trafficDetail = "";
    if (rank !== null) {
      if (rank <= 5) trafficScore = 10;
      else if (rank <= 40) trafficScore = 9;
      else if (rank <= 100) trafficScore = 8;
      else if (rank <= 200) trafficScore = 5;
      else if (rank <= 300) trafficScore = 3;
      trafficDetail = "광고를 제외한 현재 오가닉 순위는 " + rank + "위입니다. " +
        (rank <= 5
          ? "다른 항목이 모두 양호하면 총점 95점 기준입니다."
          : (rank <= 40
            ? "상위 40위 구간으로 트래픽 점수 9점을 반영합니다."
            : (rank <= 100
              ? "상위 100위 구간으로 확인되어 기본 노출 근거 8점을 반영합니다."
              : "확인된 순위 구간에 따라 기본 노출 점수를 반영하며 트래픽 보완이 필요합니다.")));
    } else if (rankVerified) {
      trafficDetail = "상위 " + rankCheckedCount + "개 오가닉 결과에서 상품을 찾지 못했습니다. 다른 항목이 모두 양호하면 총점 85점 기준이며 트래픽·클릭·판매 반응을 보완해야 합니다.";
    }
    addCheck(
      "traffic",
      "트래픽·노출",
      trafficDetail,
      trafficScore,
      15,
      rankVerified,
      "광고 제외 오가닉 순위 자동 확인"
    );

    var scoredChecks = checks.filter(function (check) { return check.verified && check.max > 0; });
    var verifiedChecks = checks.filter(function (check) { return check.verified; });
    var verifiedMax = verifiedChecks.reduce(function (sum, check) { return sum + check.max; }, 0);
    var earned = scoredChecks.reduce(function (sum, check) { return sum + check.score; }, 0);
    var confidence = Math.round((verifiedMax / 100) * 100);
    var score = Math.min(100, earned);
    var baseKeys = ["titleFit", "topKeywordFit", "categoryFit", "brandMaker", "imageReady", "reviewManual"];
    var baseChecks = scoredChecks.filter(function (check) { return baseKeys.includes(check.key); });
    var baseMax = baseChecks.reduce(function (sum, check) { return sum + check.max; }, 0);
    var baseScore = baseChecks.reduce(function (sum, check) { return sum + check.score; }, 0);
    var seoBasicsStrong = baseMax === 85 && baseScore >= 80;
    var weakExposure = rankVerified && (rank === null || rank > 5);
    var resultGrade = grade(score);
    var diagnosis = {
      key: weakExposure ? "traffic" : (seoBasicsStrong ? "ready" : "optimize"),
      label: weakExposure ? "등록 품질 점검 · 트래픽 보완" : (seoBasicsStrong ? "상품 등록 품질 양호" : "상품 등록 항목 보완"),
      detail: weakExposure
        ? "현재 오가닉 순위가 상위 5위 밖입니다. 확인된 등록 항목과 별개로 검색 유입·클릭·판매 반응을 만드는 트래픽 보완이 필요합니다."
        : (seoBasicsStrong ? "자동 확인된 상품 등록 품질과 현재 노출 상태가 양호합니다." : "자동으로 확인된 상품 등록 항목 중 낮은 항목을 먼저 보완하세요.")
    };
    if (weakExposure) {
      resultGrade = {
        label: diagnosis.label,
        copy: "자동 확인된 등록 항목과 별개로 현재 순위 근거상 트래픽·클릭·판매 반응을 보완해야 합니다."
      };
    }

    var actions = checks
      .filter(function (check) { return check.max > 0 && check.score / check.max < 0.75; })
      .sort(function (left, right) {
        var leftGap = left.max - left.score;
        var rightGap = right.max - right.score;
        return rightGap - leftGap;
      })
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

    if (weakExposure) {
      actions = actions.filter(function (action) { return action.key !== "traffic"; });
      actions.unshift({
        key: "traffic",
        title: "트래픽·노출 보완",
        detail: actionText("traffic"),
        score: trafficScore,
        max: 15,
        verified: true
      });
    }
    actions = actions.slice(0, 3);
    if (!actions.length) {
      actions = [{ key: "maintain", title: "유지 관리", detail: "현재 상품 SEO 기본 항목이 양호합니다. 순위와 리뷰 변화를 계속 확인하세요.", score: score, max: 100, verified: true }];
    }

    return {
      version: VERSION,
      policyId: POLICY_ID,
      score: Math.max(0, Math.min(100, score)),
      confidence: Math.max(0, Math.min(100, confidence)),
      grade: resultGrade,
      diagnosis: diagnosis,
      checks: checks,
      actions: actions,
      reviewCount: reviewCount,
      reviewLabel: reviewLabel,
      topKeywordBenchmark: topKeywordBenchmark,
      titleKeywordIncluded: keywordIncluded,
      titleKeywordMatchLevel: keywordMatch.level,
      titleLength: titleLength,
      titleIssues: titleQuality,
      categoryLabel: categoryBenchmark ? categoryBenchmark.label : "",
      dominantCategory: categoryBenchmark ? categoryBenchmark.category : "",
      verifiedMax: verifiedMax
    };
  }

  global.MomentSeoEvaluation = Object.freeze({
    version: VERSION,
    policyId: POLICY_ID,
    evaluate: evaluate,
    optionalNumber: optionalNumber
  });
}(typeof window !== "undefined" ? window : globalThis));
