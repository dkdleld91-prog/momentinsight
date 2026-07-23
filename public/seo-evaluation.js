(function (global) {
  "use strict";

  var VERSION = "seo_v4_product_optimization_20260723";

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
    return ["complete", "incomplete", "direct", "reference", "applied", "none"].includes(state) ? state : "";
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

  function grade(score, confidence) {
    if (confidence < 80) {
      return {
        label: "확인 항목 입력 필요",
        copy: "자동 확인 결과와 판매자 확인 항목이 모두 갖춰져야 최종 SEO 상태를 판단할 수 있습니다."
      };
    }
    if (score >= 90) return { label: "A · SEO 기본 양호", copy: "상품 검색 최적화의 기본 항목이 안정적으로 갖춰져 있습니다." };
    if (score >= 80) return { label: "B+ · 일부 보완", copy: "기본 구조는 양호하며 낮은 항목을 보완하면 검색 노출 준비도가 더 안정적입니다." };
    if (score >= 70) return { label: "B · 보완 필요", copy: "상품명·카테고리·상세 정보 중 약한 항목을 먼저 개선해야 합니다." };
    if (score >= 55) return { label: "C · 수정 우선", copy: "검색 최적화 기본 항목 여러 개를 함께 보완해야 합니다." };
    return { label: "D · 재점검", copy: "상품 등록의 검색 최적화 기준을 처음부터 다시 점검해야 합니다." };
  }

  function actionText(key) {
    var actions = {
      titleKeyword: "기준 키워드를 상품명에 자연스럽게 포함하세요.",
      titleLength: "핵심 정보만 남겨 상품명을 40자 이내로 정리하세요.",
      category: "상위 노출 상품과 동일한 세부 상품군에 속하는지 확인하고 정확한 카테고리를 선택하세요.",
      review: "정책을 준수하는 구매 경험과 리뷰 관리로 실제 리뷰를 꾸준히 확보하세요.",
      detailPage: "상세페이지의 핵심 정보와 이미지가 잘리지 않도록 전체 구성의 80% 이상을 완성하세요.",
      productNotice: "상품정보고시는 ‘상세페이지 참고’ 대신 각 항목을 직접 작성하세요.",
      discount: "실제 판매 정책에 맞는 할인율과 기준 가격을 명확하게 적용하세요.",
      reviewPoint: "정책 범위 안에서 리뷰 포인트 지급 조건을 설정하고 고객에게 분명히 안내하세요.",
      traffic: "상품 SEO 기본 항목은 양호합니다. 검색 노출과 유입 경로, 외부 트래픽 운영 상태를 추가 점검하세요."
    };
    return actions[key] || "확인되지 않았거나 점수가 낮은 항목부터 보완하세요.";
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
      "상품명 40자 이내",
      title ? "현재 상품명은 " + titleLength + "자입니다." + (titleLength <= 40 ? " 권장 범위입니다." : " 40자 이내로 줄여야 합니다.") : "상품명 길이를 확인하지 못했습니다.",
      title && titleLength <= 40 ? 10 : 0,
      10,
      Boolean(title),
      "자동 확인"
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
    var reviewLabel = "미입력";
    if (reviewVerified) {
      if (reviewCount >= 1000) { reviewScore = 20; reviewLabel = "매우 강함"; }
      else if (reviewCount >= 300) { reviewScore = 17; reviewLabel = "강함"; }
      else if (reviewCount >= 100) { reviewScore = 14; reviewLabel = "양호"; }
      else if (reviewCount >= 20) { reviewScore = 10; reviewLabel = "성장"; }
      else if (reviewCount > 0) { reviewScore = 5; reviewLabel = "보완"; }
      else { reviewLabel = "리뷰 없음"; }
    }
    addCheck(
      "review",
      "리뷰 축적",
      reviewVerified ? "확인된 리뷰 " + formatNumber(reviewCount) + "개 기준이며 리뷰 신호는 " + reviewLabel + "입니다." : "현재 리뷰 수를 입력하면 리뷰 축적 상태를 반영합니다.",
      reviewScore,
      20,
      reviewVerified,
      reviewVerified ? "직접 확인" : "확인 필요"
    );

    var detailPageState = normalizedState(input.detailPageState);
    addCheck(
      "detailPage",
      "상세페이지 80% 이상",
      detailPageState === "complete" ? "핵심 정보와 이미지가 잘리지 않도록 상세페이지가 80% 이상 구성된 것으로 확인했습니다." : (detailPageState === "incomplete" ? "상세페이지가 짧거나 일부 정보·이미지가 잘려 보완이 필요합니다." : "공개 API만으로 상세페이지 완성도를 확정할 수 없어 판매자 확인이 필요합니다."),
      detailPageState === "complete" ? 10 : 0,
      10,
      Boolean(detailPageState),
      detailPageState ? "판매자 확인" : "확인 필요"
    );

    var noticeState = normalizedState(input.noticeState);
    addCheck(
      "productNotice",
      "상품정보고시 직접 작성",
      noticeState === "direct" ? "상품정보고시를 ‘상세페이지 참고’ 없이 항목별로 직접 작성했습니다." : (noticeState === "reference" ? "상품정보고시에 ‘상세페이지 참고’가 포함되어 있어 직접 작성이 필요합니다." : "공개 API만으로 상품정보고시 입력 방식을 확정할 수 없어 판매자 확인이 필요합니다."),
      noticeState === "direct" ? 10 : 0,
      10,
      Boolean(noticeState),
      noticeState ? "판매자 확인" : "확인 필요"
    );

    var discountState = normalizedState(input.discountState);
    addCheck(
      "discount",
      "할인율 적용",
      discountState === "applied" ? "할인율이 적용된 것으로 확인했습니다." : (discountState === "none" ? "할인율이 적용되지 않은 상태입니다." : "가격 API만으로 실제 할인 정책을 확정할 수 없어 판매자 확인이 필요합니다."),
      discountState === "applied" ? 8 : 0,
      8,
      Boolean(discountState),
      input.discountAuto && discountState === "applied" ? "자동 확인" : (discountState ? "판매자 확인" : "확인 필요")
    );

    var reviewPointState = normalizedState(input.reviewPointState);
    addCheck(
      "reviewPoint",
      "리뷰 포인트 적용",
      reviewPointState === "applied" ? "리뷰 포인트 지급 조건이 적용된 것으로 확인했습니다." : (reviewPointState === "none" ? "리뷰 포인트가 적용되지 않은 상태입니다." : "공개 API만으로 리뷰 포인트 정책을 확정할 수 없어 판매자 확인이 필요합니다."),
      reviewPointState === "applied" ? 7 : 0,
      7,
      Boolean(reviewPointState),
      reviewPointState ? "판매자 확인" : "확인 필요"
    );

    var verifiedChecks = checks.filter(function (check) { return check.verified; });
    var verifiedMax = verifiedChecks.reduce(function (sum, check) { return sum + check.max; }, 0);
    var earned = verifiedChecks.reduce(function (sum, check) { return sum + check.score; }, 0);
    var confidence = Math.round(verifiedMax);
    var score = verifiedMax ? Math.round((earned / verifiedMax) * 100) : 0;
    var rank = optionalNumber(input.rank);
    var rankCheckedCount = optionalNumber(input.rankCheckedCount);
    var seoBasicsStrong = confidence === 100 && score >= 85;
    var weakExposure = seoBasicsStrong && ((rank !== null && rank > 100) || (rank === null && rankCheckedCount !== null && rankCheckedCount >= 300));
    var resultGrade = grade(score, confidence);
    var diagnosis = {
      key: weakExposure ? "traffic" : (seoBasicsStrong ? "ready" : "optimize"),
      label: weakExposure ? "SEO 기본 양호 · 트래픽 점검" : (seoBasicsStrong ? "SEO 기본 양호" : "SEO 항목 보완"),
      detail: weakExposure
        ? "기본 SEO 항목은 양호하지만 오가닉 노출이 약합니다. 트래픽 부족 가능성과 노출 운영 상태를 추가 점검하세요."
        : (seoBasicsStrong ? "상품 SEO 기본 항목과 현재 노출 상태가 양호합니다." : "낮거나 확인되지 않은 SEO 항목을 먼저 보완하세요.")
    };
    if (weakExposure) {
      resultGrade = {
        label: diagnosis.label,
        copy: "기본 SEO 항목은 양호합니다. 다만 현재 노출 근거상 트래픽·노출 운영 상태를 추가로 확인해야 합니다."
      };
    }

    var actions = checks
      .filter(function (check) { return !check.verified || check.score / check.max < 0.75; })
      .sort(function (left, right) {
        var leftGap = left.verified ? left.max - left.score : left.max;
        var rightGap = right.verified ? right.max - right.score : right.max;
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
      titleKeywordIncluded: keywordIncluded,
      titleLength: titleLength,
      categoryLabel: categoryLabel,
      dominantCategory: dominantCategory ? dominantCategory.label : "",
      manualVerifiedCount: [detailPageState, noticeState, discountState, reviewPointState].filter(Boolean).length
    };
  }

  global.MomentSeoEvaluation = Object.freeze({
    version: VERSION,
    evaluate: evaluate,
    optionalNumber: optionalNumber
  });
}(typeof window !== "undefined" ? window : globalThis));
