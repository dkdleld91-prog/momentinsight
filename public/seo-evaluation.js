(function (global) {
  "use strict";

  var VERSION = "seo_v7_naver_guide_review_benchmark_20260723";

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

  function normalizedState(value) {
    var state = text(value).toLowerCase();
    return ["applied", "none"].includes(state) ? state : "";
  }

  function categoryParts(value) {
    return text(value).split(">").map(function (part) { return compact(part); }).filter(Boolean);
  }

  function sharedCategoryDepth(left, right) {
    var leftParts = categoryParts(left);
    var rightParts = categoryParts(right);
    var depth = 0;
    while (depth < leftParts.length && depth < rightParts.length && leftParts[depth] === rightParts[depth]) depth += 1;
    return depth;
  }

  function dominantPeerCategory(peerCategories) {
    var counts = {};
    var labels = {};
    (Array.isArray(peerCategories) ? peerCategories : []).forEach(function (category) {
      var label = text(category);
      var key = compact(label);
      if (!key) return;
      counts[key] = (counts[key] || 0) + 1;
      labels[key] = label;
    });
    var keys = Object.keys(counts).sort(function (left, right) {
      return counts[right] - counts[left];
    });
    return keys.length ? { label: labels[keys[0]], count: counts[keys[0]], total: Object.values(counts).reduce(function (sum, count) { return sum + count; }, 0) } : null;
  }

  function uniqueTextValues(values) {
    var seen = {};
    return (Array.isArray(values) ? values : []).map(text).filter(function (value) {
      var key = compact(value);
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function meaningfulTitleTokens(value) {
    var ignored = {
      "개": true,
      "팩": true,
      "세트": true,
      "set": true,
      "형": true,
      "용": true,
      "대": true,
      "소": true
    };
    return (text(value).toLowerCase().match(/[가-힣a-z0-9]+/g) || []).filter(function (token) {
      return token.length >= 2 && !ignored[token] && !/^\d+$/.test(token);
    });
  }

  function repeatedTitleTokens(value) {
    var counts = {};
    meaningfulTitleTokens(value).forEach(function (token) {
      counts[token] = (counts[token] || 0) + 1;
    });
    return Object.keys(counts).filter(function (token) { return counts[token] >= 2; });
  }

  function titleGuideState(value) {
    var title = text(value);
    var promotionMatches = title.match(/무료\s*배송|당일\s*배송|오늘\s*출발|최저가|특가|할인|쿠폰|사은품|증정|이벤트|품절|재입고|신상품|MD\s*추천|선착순|타임\s*세일|공동\s*구매|무료\s*반품/gi) || [];
    var contactIssue = /(?:^|[^0-9])(?:0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4})(?:[^0-9]|$)/.test(title);
    var specialMatches = title.match(/[^\p{L}\p{N}\s]/gu) || [];
    var decorativeIssue = /[★☆♥♡◆◇■□●○※♬♪♠♣♦♧♤♢]/.test(title);
    return {
      repeatedTokens: repeatedTitleTokens(title),
      promotionTerms: uniqueTextValues(promotionMatches),
      contactIssue: contactIssue,
      specialCount: specialMatches.length,
      specialIssue: decorativeIssue || specialMatches.length > 4
    };
  }

  function reviewBenchmarkState(input, reviewCount) {
    var rawCounts = Array.isArray(input.peerReviewCounts)
      ? input.peerReviewCounts.map(optionalNumber).filter(function (value) { return value !== null; })
      : [];
    if (reviewCount === null || rawCounts.length < 2) return null;
    var counts = rawCounts.slice(0, 3).sort(function (left, right) { return left - right; });
    var middle = Math.floor(counts.length / 2);
    var median = counts.length % 2 ? counts[middle] : Math.round((counts[middle - 1] + counts[middle]) / 2);
    var average = Math.round(counts.reduce(function (sum, value) { return sum + value; }, 0) / counts.length);
    var ratio = median > 0 ? reviewCount / median : (reviewCount > 0 ? 1 : 0);
    var score = ratio >= 1 ? 15 : (ratio >= 0.6 ? 12 : (ratio >= 0.3 ? 8 : (ratio >= 0.1 ? 4 : 0)));
    var label = ratio >= 1 ? "상위권 수준" : (ratio >= 0.6 ? "근접" : (ratio >= 0.3 ? "보완" : "매우 부족"));
    return {
      verified: true,
      sampleSize: counts.length,
      peerCounts: counts,
      median: median,
      average: average,
      ratio: ratio,
      score: score,
      max: 15,
      label: label
    };
  }

  function grade(score) {
    if (score >= 90) return { label: "A · 등록 품질 양호", copy: "자동으로 확인된 상품 등록 품질이 양호합니다. 이 점수는 검색 순위를 보장하지 않습니다." };
    if (score >= 80) return { label: "B+ · 일부 보완", copy: "기본 구조는 양호하며 낮은 항목을 보완하면 검색 노출 준비도가 더 안정적입니다." };
    if (score >= 70) return { label: "B · 보완 필요", copy: "상품명·카테고리·리뷰 경쟁력 중 확인된 약한 항목을 먼저 개선해야 합니다." };
    if (score >= 55) return { label: "C · 수정 우선", copy: "상품 등록 품질의 기본 항목 여러 개를 함께 보완해야 합니다." };
    return { label: "D · 재점검", copy: "상품 등록 품질 기준을 처음부터 다시 점검해야 합니다." };
  }

  function actionText(key) {
    var actions = {
      titleKeyword: "기준 키워드를 상품명에 자연스럽게 포함하세요.",
      titleLength: "핵심 정보만 남겨 상품명을 50자 이내로 정리하세요.",
      titleIdentity: "공식 상품 정보에 등록된 브랜드 또는 제조사 명칭을 상품명에 정확하게 사용하세요.",
      titleRepetition: "같은 단어나 유사한 표현을 반복하지 말고 한 번만 간결하게 사용하세요.",
      titlePromotion: "할인·쿠폰·배송·사은품 같은 판매 조건은 상품명이 아니라 전용 정보란에 입력하세요.",
      titleContact: "전화번호와 연락처는 상품명에서 제거하세요.",
      titleSpecialChars: "장식용 기호와 과도한 특수문자를 제거하고 읽기 쉬운 상품명으로 정리하세요.",
      category: "상위 노출 상품과 동일한 세부 상품군에 속하는지 확인하고 정확한 카테고리를 선택하세요.",
      review: "정책을 준수하는 구매 경험과 리뷰 관리로 실제 리뷰를 꾸준히 확보하세요.",
      reviewBenchmark: "상위 오가닉 상품의 실제 리뷰 중앙값을 기준으로 부족한 리뷰 신뢰도를 보완하세요.",
      discount: "실제 판매 정책에 맞는 할인율과 기준 가격을 명확하게 적용하세요.",
      reviewPoint: "정책 범위 안에서 리뷰 포인트 지급 조건을 설정하고 고객에게 분명히 안내하세요.",
      traffic: "상품 등록 품질과 리뷰 경쟁력은 양호합니다. 검색 유입·클릭·판매 반응을 만드는 트래픽 운영 상태를 추가 점검하세요."
    };
    return actions[key] || "점수가 낮은 항목부터 보완하세요.";
  }

  function evaluate(input) {
    input = input || {};
    var keyword = text(input.keyword);
    var title = text(input.title);
    var category = text(input.category);
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

    addCheck(
      "titleKeyword",
      "상품명 키워드",
      title
        ? (keywordIncluded ? "기준 키워드가 상품명에 포함되어 있습니다." : "기준 키워드가 상품명에 포함되어 있지 않습니다.")
        : "상품 URL에서 정확한 상품명을 확인하지 못했습니다.",
      keywordIncluded ? 15 : 0,
      15,
      Boolean(title && keyword),
      "자동 확인"
    );

    addCheck(
      "titleLength",
      "상품명 50자 이내",
      title ? "현재 상품명은 " + titleLength + "자입니다." + (titleLength <= 50 ? " 권장 범위입니다." : " 50자 이내로 줄여야 합니다.") : "",
      title && titleLength <= 50 ? 10 : 0,
      10,
      Boolean(title),
      "자동 확인"
    );

    var guide = titleGuideState(title);
    var identities = uniqueTextValues([input.brand, input.maker]);
    var identityIncluded = identities.some(function (identity) {
      return compact(title).includes(compact(identity));
    });
    addCheck(
      "titleIdentity",
      "공식 브랜드·제조사 명칭",
      identityIncluded
        ? "공식 조회 정보의 " + identities.join("·") + " 명칭이 상품명에 포함되어 있습니다."
        : "공식 조회 정보의 " + identities.join("·") + " 명칭이 상품명에 확인되지 않습니다.",
      identityIncluded ? 10 : 0,
      10,
      Boolean(title && identities.length),
      "공식 조회 자동 확인"
    );

    addCheck(
      "titleRepetition",
      "동일 단어 반복",
      guide.repeatedTokens.length
        ? "상품명에서 반복된 단어를 확인했습니다: " + guide.repeatedTokens.join(", ") + "."
        : "같은 단어를 불필요하게 반복하지 않았습니다.",
      guide.repeatedTokens.length ? 0 : 6,
      6,
      Boolean(title),
      "네이버 가이드 자동 확인"
    );

    addCheck(
      "titlePromotion",
      "홍보·가격·배송 문구",
      guide.promotionTerms.length
        ? "상품명에서 별도 정보란에 넣어야 할 문구를 확인했습니다: " + guide.promotionTerms.join(", ") + "."
        : "할인·쿠폰·배송·사은품 같은 홍보 문구가 상품명에 없습니다.",
      guide.promotionTerms.length ? 0 : 6,
      6,
      Boolean(title),
      "네이버 가이드 자동 확인"
    );

    addCheck(
      "titleContact",
      "전화번호 사용",
      guide.contactIssue ? "상품명에서 전화번호 형식이 확인됐습니다." : "상품명에 전화번호 형식이 없습니다.",
      guide.contactIssue ? 0 : 4,
      4,
      Boolean(title),
      "네이버 가이드 자동 확인"
    );

    addCheck(
      "titleSpecialChars",
      "특수문자 사용",
      guide.specialIssue
        ? "장식용 또는 과도한 특수문자가 확인됐습니다."
        : "상품명의 특수문자 사용이 과도하지 않습니다.",
      guide.specialIssue ? 0 : 4,
      4,
      Boolean(title),
      "네이버 가이드 자동 확인"
    );

    var dominantCategory = dominantPeerCategory(input.peerCategories);
    var categoryVerified = Boolean(category && dominantCategory);
    var categoryDepth = categoryVerified ? sharedCategoryDepth(category, dominantCategory.label) : 0;
    var categoryExact = categoryVerified && compact(category) === compact(dominantCategory.label);
    var categoryScore = categoryExact ? 20 : (categoryDepth >= 3 ? 14 : (categoryDepth >= 2 ? 8 : 0));
    var categoryLabel = !categoryVerified ? "비교 필요" : (categoryExact ? "동일 상품군" : (categoryDepth >= 3 ? "세부 확인" : "불일치"));
    var categoryDetail = categoryVerified
      ? "현재 상품은 " + category + "이며, 상위 비교 상품 " + dominantCategory.total + "개 중 대표 상품군은 " + dominantCategory.label + "입니다. " + categoryLabel + "로 판단됩니다."
      : (category ? "현재 카테고리는 확인했지만 동종 상위 상품의 비교 카테고리가 부족합니다." : "상품 카테고리를 확인하지 못했습니다.");
    addCheck("category", "동종 상품 카테고리", categoryDetail, categoryScore, 20, categoryVerified, "자동 비교");

    var reviewCount = optionalNumber(input.reviewCount);
    var reviewVerified = reviewCount !== null;
    var reviewScore = 0;
    var reviewLabel = "";
    if (reviewVerified) {
      if (reviewCount >= 1000) { reviewScore = 10; reviewLabel = "매우 강함"; }
      else if (reviewCount >= 300) { reviewScore = 9; reviewLabel = "강함"; }
      else if (reviewCount >= 100) { reviewScore = 7; reviewLabel = "양호"; }
      else if (reviewCount >= 20) { reviewScore = 5; reviewLabel = "성장"; }
      else if (reviewCount > 0) { reviewScore = 2; reviewLabel = "보완"; }
      else { reviewLabel = "리뷰 없음"; }
    }
    addCheck(
      "review",
      "리뷰 축적",
      reviewVerified ? "네이버 공개 화면에서 확인한 리뷰 " + formatNumber(reviewCount) + "개 기준이며 리뷰 신호는 " + reviewLabel + "입니다." : "네이버 공개 화면에서 현재 리뷰 수를 자동 확인하지 못했습니다.",
      reviewScore,
      10,
      reviewVerified,
      "공개 화면 자동 확인"
    );

    var reviewBenchmark = reviewBenchmarkState(input, reviewCount);
    addCheck(
      "reviewBenchmark",
      "상위 오가닉 리뷰 비교",
      reviewBenchmark
        ? "내 상품 리뷰 " + formatNumber(reviewCount) + "개와 상위 오가닉 " + reviewBenchmark.sampleSize + "개 상품의 리뷰 중앙값 " + formatNumber(reviewBenchmark.median) + "개를 비교했습니다. 현재 수준은 " + reviewBenchmark.label + "입니다."
        : "",
      reviewBenchmark ? reviewBenchmark.score : 0,
      15,
      Boolean(reviewBenchmark),
      "상위 상품 공개 화면 자동 비교"
    );

    var discountState = normalizedState(input.discountState);
    addCheck(
      "discount",
      "할인율 적용",
      discountState === "applied" ? "네이버 공개 판매가에서 할인 적용을 확인했습니다." : (discountState === "none" ? "네이버 공개 판매가에서 할인 미적용 상태를 확인했습니다." : "네이버 공개 화면에서 할인 정책을 자동 확인하지 못했습니다."),
      discountState === "applied" ? 8 : 0,
      8,
      Boolean(discountState),
      "공개 화면 자동 확인"
    );

    var reviewPointState = normalizedState(input.reviewPointState);
    addCheck(
      "reviewPoint",
      "리뷰 포인트 적용",
      reviewPointState === "applied" ? "네이버 공개 혜택에서 리뷰 포인트 적용을 확인했습니다." : (reviewPointState === "none" ? "네이버 공개 혜택에서 리뷰 포인트 미적용 상태를 확인했습니다." : "네이버 공개 화면에서 리뷰 포인트 정책을 자동 확인하지 못했습니다."),
      reviewPointState === "applied" ? 7 : 0,
      7,
      Boolean(reviewPointState),
      "공개 화면 자동 확인"
    );

    var verifiedChecks = checks.filter(function (check) { return check.verified; });
    var verifiedMax = verifiedChecks.reduce(function (sum, check) { return sum + check.max; }, 0);
    var earned = verifiedChecks.reduce(function (sum, check) { return sum + check.score; }, 0);
    var confidence = Math.round((verifiedMax / 115) * 100);
    var score = verifiedMax ? Math.round((earned / verifiedMax) * 100) : 0;
    var rank = optionalNumber(input.rank);
    var rankCheckedCount = optionalNumber(input.rankCheckedCount);
    var blockingKeys = [
      "titleKeyword",
      "titleLength",
      "titleRepetition",
      "titlePromotion",
      "titleContact",
      "titleSpecialChars",
      "category",
      reviewBenchmark ? "reviewBenchmark" : "review"
    ];
    var blockingChecks = checks.filter(function (check) { return blockingKeys.includes(check.key); });
    var seoBasicsStrong = blockingChecks.length >= 8
      && blockingChecks.every(function (check) { return check.score / check.max >= 0.75; })
      && score >= 85;
    var weakExposure = seoBasicsStrong && ((rank !== null && rank > 40) || (rank === null && rankCheckedCount !== null && rankCheckedCount >= 300));
    var resultGrade = grade(score);
    var diagnosis = {
      key: weakExposure ? "traffic" : (seoBasicsStrong ? "ready" : "optimize"),
      label: weakExposure ? "등록 품질 양호 · 트래픽 부족 가능성" : (seoBasicsStrong ? "상품 등록 품질 양호" : "상품 등록 항목 보완"),
      detail: weakExposure
        ? "자동 확인된 상품 등록 품질과 리뷰 경쟁력은 양호하지만 오가닉 순위가 낮습니다. 트래픽·클릭·판매 반응 부족 가능성을 추가 점검하세요."
        : (seoBasicsStrong ? "자동 확인된 상품 등록 품질과 현재 노출 상태가 양호합니다." : "자동으로 확인된 상품 등록 항목 중 낮은 항목을 먼저 보완하세요.")
    };
    if (weakExposure) {
      resultGrade = {
        label: diagnosis.label,
        copy: "상품 등록 품질은 양호합니다. 다만 현재 순위 근거상 트래픽·클릭·판매 반응을 추가로 확인해야 합니다."
      };
    }

    var actions = checks
      .filter(function (check) { return check.score / check.max < 0.75; })
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
      actions.unshift({ key: "traffic", title: "트래픽·노출 점검", detail: actionText("traffic"), score: 0, max: 1, verified: true });
    }
    actions = actions.slice(0, 3);
    if (!actions.length) {
      actions = [{ key: "maintain", title: "유지 관리", detail: "현재 상품 SEO 기본 항목이 양호합니다. 순위와 리뷰 변화를 계속 확인하세요.", score: score, max: 100, verified: true }];
    }

    return {
      version: VERSION,
      score: Math.max(0, Math.min(100, score)),
      confidence: Math.max(0, Math.min(100, confidence)),
      grade: resultGrade,
      diagnosis: diagnosis,
      checks: checks,
      actions: actions,
      reviewCount: reviewCount,
      reviewLabel: reviewLabel,
      reviewBenchmark: reviewBenchmark,
      titleKeywordIncluded: keywordIncluded,
      titleLength: titleLength,
      categoryLabel: categoryLabel,
      dominantCategory: dominantCategory ? dominantCategory.label : "",
      verifiedMax: verifiedMax
    };
  }

  global.MomentSeoEvaluation = Object.freeze({
    version: VERSION,
    evaluate: evaluate,
    optionalNumber: optionalNumber
  });
}(typeof window !== "undefined" ? window : globalThis));
