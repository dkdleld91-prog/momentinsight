(function (global) {
  "use strict";

  var VERSION = "seo_v8_traffic_review_tags_notice_20260723";

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

  function uniqueTextValues(values) {
    var seen = {};
    return (Array.isArray(values) ? values : []).map(text).filter(function (value) {
      var key = compact(value);
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function reviewBenchmarkState(input, reviewCount) {
    var rawCounts = Array.isArray(input.peerReviewCounts)
      ? input.peerReviewCounts.map(optionalNumber).filter(function (value) { return value !== null; })
      : [];
    if (reviewCount === null || rawCounts.length < 2) return null;
    var counts = rawCounts.slice(0, 5).sort(function (left, right) { return left - right; });
    var middle = Math.floor(counts.length / 2);
    var median = counts.length % 2 ? counts[middle] : Math.round((counts[middle - 1] + counts[middle]) / 2);
    var average = Math.round(counts.reduce(function (sum, value) { return sum + value; }, 0) / counts.length);
    var ratio = average > 0 ? reviewCount / average : (reviewCount > 0 ? 1 : 0);
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
      reviewBenchmark: "상위 오가닉 상품의 실제 리뷰 평균을 기준으로 부족한 리뷰 수량을 보완하세요.",
      productNotice: "상품정보제공고시를 항목별로 작성하고 ‘상세페이지 참조’ 문구는 제거하세요.",
      sellerTags: "상품과 관련된 검색 태그를 중복 없이 10개 등록하세요.",
      discount: "실제 판매 정책에 맞는 할인율과 기준 가격을 명확하게 적용하세요.",
      reviewPoint: "정책 범위 안에서 리뷰 포인트 지급 조건을 설정하고 고객에게 분명히 안내하세요.",
      traffic: "현재 오가닉 순위가 5위 밖입니다. 검색 유입·클릭·판매 반응을 만드는 트래픽 운영을 보완하세요."
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

    var reviewCount = optionalNumber(input.reviewCount);
    var reviewVerified = reviewCount !== null;
    var reviewLabel = "";
    if (reviewVerified) {
      if (reviewCount >= 1000) reviewLabel = "매우 강함";
      else if (reviewCount >= 300) reviewLabel = "강함";
      else if (reviewCount >= 100) reviewLabel = "양호";
      else if (reviewCount >= 20) reviewLabel = "성장";
      else if (reviewCount > 0) reviewLabel = "보완";
      else { reviewLabel = "리뷰 없음"; }
    }

    var reviewBenchmark = reviewBenchmarkState(input, reviewCount);
    addCheck(
      "reviewBenchmark",
      "리뷰 수량",
      reviewBenchmark
        ? "내 상품 리뷰 " + formatNumber(reviewCount) + "개와 상위 오가닉 " + reviewBenchmark.sampleSize + "개 상품의 리뷰 평균 " + formatNumber(reviewBenchmark.average) + "개를 비교했습니다. 현재 수준은 " + reviewBenchmark.label + "입니다."
        : "",
      reviewBenchmark ? reviewBenchmark.score : 0,
      15,
      Boolean(reviewBenchmark),
      "상위 상품 공개 화면 자동 비교"
    );

    var productNotice = input.productNotice && typeof input.productNotice === "object" ? input.productNotice : null;
    addCheck(
      "productNotice",
      "상품정보제공고시",
      productNotice
        ? (productNotice.hasDetailReference
          ? "상품정보제공고시에 ‘상세페이지 참조’ 문구가 확인됐습니다. 항목별 정보로 작성해야 합니다."
          : "상품정보제공고시가 항목별로 작성되어 있고 ‘상세페이지 참조’ 문구가 없습니다.")
        : "",
      productNotice && !productNotice.hasDetailReference ? 10 : 0,
      10,
      Boolean(productNotice && productNotice.verified),
      "네이버 상품 정보 자동 확인"
    );

    var sellerTags = input.sellerTags && typeof input.sellerTags === "object" ? input.sellerTags : null;
    var sellerTagCount = sellerTags && Array.isArray(sellerTags.values)
      ? uniqueTextValues(sellerTags.values).length
      : optionalNumber(sellerTags && sellerTags.count);
    var sellerTagScore = sellerTagCount === null ? 0 : (sellerTagCount >= 10 ? 10 : Math.round((sellerTagCount / 10) * 10));
    addCheck(
      "sellerTags",
      "검색 태그 10개",
      sellerTagCount === null
        ? ""
        : "관련 태그 " + sellerTagCount + "개를 확인했습니다." + (sellerTagCount >= 10 ? " 권장 수량 10개가 모두 등록되어 있습니다." : " 중복 없이 10개까지 보완하세요."),
      sellerTagScore,
      10,
      Boolean(sellerTags && sellerTags.verified && sellerTagCount !== null),
      "네이버 공개 상품 자동 확인"
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

    var rank = optionalNumber(input.rank);
    var rankCheckedCount = optionalNumber(input.rankCheckedCount);
    var rankVerified = rank !== null || (rank === null && rankCheckedCount !== null && rankCheckedCount >= 300);
    var trafficScore = 0;
    var trafficDetail = "";
    if (rank !== null) {
      if (rank <= 5) trafficScore = 25;
      else if (rank <= 10) trafficScore = 20;
      else if (rank <= 20) trafficScore = 15;
      else if (rank <= 40) trafficScore = 10;
      else if (rank <= 100) trafficScore = 5;
      else trafficScore = 2;
      trafficDetail = "광고를 제외한 현재 오가닉 순위는 " + rank + "위입니다." +
        (rank <= 5 ? " 상위 5위 기준을 충족했습니다." : " 상위 5위 진입을 위해 검색 유입·클릭·판매 반응을 만드는 트래픽 보완이 필요합니다.");
    } else if (rankVerified) {
      trafficDetail = "상위 " + rankCheckedCount + "개 오가닉 결과에서 상품을 찾지 못했습니다. 상품 등록 상태와 함께 트래픽·클릭·판매 반응을 우선 점검하세요.";
    }
    addCheck(
      "traffic",
      "트래픽·노출",
      trafficDetail,
      trafficScore,
      25,
      rankVerified,
      "광고 제외 오가닉 순위 자동 확인"
    );

    var verifiedChecks = checks.filter(function (check) { return check.verified; });
    var verifiedMax = verifiedChecks.reduce(function (sum, check) { return sum + check.max; }, 0);
    var earned = verifiedChecks.reduce(function (sum, check) { return sum + check.score; }, 0);
    var confidence = Math.round((verifiedMax / 100) * 100);
    var score = verifiedMax ? Math.round((earned / verifiedMax) * 100) : 0;
    if (verifiedMax < 100 || rank === null || rank > 5) score = Math.min(score, 99);
    var blockingKeys = ["titleKeyword", "titleLength", "reviewBenchmark", "productNotice", "sellerTags", "traffic"];
    var blockingChecks = checks.filter(function (check) { return blockingKeys.includes(check.key); });
    var seoBasicsStrong = blockingChecks.length >= 4
      && blockingChecks.every(function (check) { return check.score / check.max >= 0.75; })
      && score >= 85;
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
      actions = actions.filter(function (action) { return action.key !== "traffic"; });
      actions.unshift({
        key: "traffic",
        title: "트래픽·노출 보완",
        detail: actionText("traffic"),
        score: trafficScore,
        max: 25,
        verified: true
      });
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
      categoryLabel: "",
      dominantCategory: "",
      verifiedMax: verifiedMax
    };
  }

  global.MomentSeoEvaluation = Object.freeze({
    version: VERSION,
    evaluate: evaluate,
    optionalNumber: optionalNumber
  });
}(typeof window !== "undefined" ? window : globalThis));
