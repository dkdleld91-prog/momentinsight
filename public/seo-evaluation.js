(function (global) {
  "use strict";

  var VERSION = "seo_v9_five_core_audit_20260726";

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

  function uniqueTextValues(values) {
    var seen = {};
    return (Array.isArray(values) ? values : []).map(text).filter(function (value) {
      var key = compact(value);
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
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
      score: ratio >= 0.8 ? 12 : (ratio >= 0.6 ? 9 : (ratio >= 0.4 ? 6 : (ratio > 0 ? 3 : 0))),
      max: 12,
      label: ratio >= 0.8 ? "일치" : (ratio >= 0.6 ? "대체로 일치" : (ratio > 0 ? "일부 불일치" : "불일치"))
    };
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
    var score = ratio >= 1 ? 20 : (ratio >= 0.6 ? 16 : (ratio >= 0.3 ? 11 : (ratio >= 0.1 ? 5 : 0)));
    var label = ratio >= 1 ? "상위권 수준" : (ratio >= 0.6 ? "근접" : (ratio >= 0.3 ? "보완" : "매우 부족"));
    return {
      verified: true,
      sampleSize: counts.length,
      peerCounts: counts,
      median: median,
      average: average,
      ratio: ratio,
      score: score,
      max: 20,
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
      titleFit: "기준 키워드를 자연스럽게 포함하고, 중복·홍보 문구를 덜어 상품명을 50자 이내로 정리하세요.",
      productFit: "상위 오가닉 상품과 동일한 세부 카테고리를 사용하고 브랜드·제조사 정보를 정확히 등록하세요.",
      reviewCompetitiveness: "상위 오가닉 상품 5개의 실제 리뷰 평균을 기준으로 부족한 리뷰 수량을 보완하세요.",
      registrationCompleteness: "검색 태그 10개, 항목별 상품정보제공고시, 상세 이미지 8컷을 완성하세요.",
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

    var titleQuality = titleQualityState(title);
    var titleDetail = keywordIncluded
      ? "기준 키워드 포함"
      : "기준 키워드 미포함";
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
      (keywordIncluded ? 15 : 0) + (titleLength <= 50 ? 5 : 0) + titleQuality.score,
      25,
      Boolean(title && keyword),
      "공식 상품명 자동 분석"
    );

    var categoryBenchmark = categoryBenchmarkState(input.category, input.peerCategories);
    var brand = text(input.brand);
    var maker = text(input.maker);
    var productFitScore = 0;
    var productFitMax = 0;
    var productDetails = [];
    if (categoryBenchmark) {
      productFitScore += categoryBenchmark.score;
      productFitMax += categoryBenchmark.max;
      productDetails.push(
        "세부 카테고리 " + categoryBenchmark.label +
        " (상위 " + categoryBenchmark.sampleSize + "개 중 " + categoryBenchmark.matched + "개)"
      );
    }
    if (brand) {
      productFitScore += 4;
      productFitMax += 4;
      productDetails.push("브랜드 " + brand);
    }
    if (maker) {
      productFitScore += 4;
      productFitMax += 4;
      productDetails.push("제조사 " + maker);
    }
    addCheck(
      "productFit",
      "상품정보 적합도",
      productDetails.join(" · "),
      productFitScore,
      productFitMax,
      productFitMax > 0,
      "상위 오가닉 상품 자동 비교"
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
      "reviewCompetitiveness",
      "리뷰 경쟁력",
      reviewBenchmark
        ? "내 상품 리뷰 " + formatNumber(reviewCount) + "개와 상위 오가닉 " + reviewBenchmark.sampleSize + "개 상품의 리뷰 평균 " + formatNumber(reviewBenchmark.average) + "개를 비교했습니다. 현재 수준은 " + reviewBenchmark.label + "입니다."
        : "",
      reviewBenchmark ? reviewBenchmark.score : 0,
      20,
      Boolean(reviewBenchmark),
      "상위 상품 공개 화면 자동 비교"
    );

    var productNotice = input.productNotice && typeof input.productNotice === "object" ? input.productNotice : null;
    var sellerTags = input.sellerTags && typeof input.sellerTags === "object" ? input.sellerTags : null;
    var sellerTagCount = sellerTags && Array.isArray(sellerTags.values)
      ? uniqueTextValues(sellerTags.values).length
      : optionalNumber(sellerTags && sellerTags.count);
    var detailImages = input.detailImages && typeof input.detailImages === "object" ? input.detailImages : null;
    var detailImageCount = optionalNumber(detailImages && detailImages.count);
    var registrationScore = 0;
    var registrationMax = 0;
    var registrationDetails = [];
    if (sellerTags && sellerTags.verified && sellerTagCount !== null) {
      registrationMax += 8;
      registrationScore += sellerTagCount >= 10 ? 8 : Math.round((sellerTagCount / 10) * 8);
      registrationDetails.push("검색 태그 " + sellerTagCount + "개");
    }
    if (productNotice && productNotice.verified) {
      registrationMax += 7;
      registrationScore += productNotice.hasDetailReference ? 0 : 7;
      registrationDetails.push(productNotice.hasDetailReference ? "상품정보고시 상세페이지 참조 있음" : "상품정보고시 항목별 작성");
    }
    if (detailImages && detailImages.verified && detailImageCount !== null) {
      registrationMax += 5;
      registrationScore += detailImageCount >= 8 ? 5 : Math.round((detailImageCount / 8) * 5);
      registrationDetails.push("상세 이미지 " + detailImageCount + "컷");
    }
    addCheck(
      "registrationCompleteness",
      "등록정보 완성도",
      registrationDetails.join(" · "),
      registrationScore,
      registrationMax,
      registrationMax > 0,
      "네이버 공개 상품 자동 확인"
    );

    var rank = optionalNumber(input.rank);
    var rankCheckedCount = optionalNumber(input.rankCheckedCount);
    var rankVerified = rank !== null || (rank === null && rankCheckedCount !== null && rankCheckedCount >= 300);
    var trafficScore = 0;
    var trafficDetail = "";
    if (rank !== null) {
      if (rank <= 5) trafficScore = 15;
      else if (rank <= 10) trafficScore = 12;
      else if (rank <= 20) trafficScore = 9;
      else if (rank <= 40) trafficScore = 6;
      else if (rank <= 100) trafficScore = 3;
      else trafficScore = 1;
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
      15,
      rankVerified,
      "광고 제외 오가닉 순위 자동 확인"
    );

    var verifiedChecks = checks.filter(function (check) { return check.verified; });
    var verifiedMax = verifiedChecks.reduce(function (sum, check) { return sum + check.max; }, 0);
    var earned = verifiedChecks.reduce(function (sum, check) { return sum + check.score; }, 0);
    var confidence = Math.round((verifiedMax / 100) * 100);
    var normalizedScore = verifiedMax ? Math.round((earned / verifiedMax) * 100) : 0;
    var score = Math.min(normalizedScore, verifiedMax);
    if (rank === null || rank > 5) score = Math.min(score, 99);
    var blockingKeys = ["titleFit", "productFit", "reviewCompetitiveness", "registrationCompleteness", "traffic"];
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
        copy: "자동 확인된 등록 항목과 별개로 현재 순위 근거상 트래픽·클릭·판매 반응을 보완해야 합니다."
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
      titleIssues: titleQuality,
      categoryLabel: categoryBenchmark ? categoryBenchmark.label : "",
      dominantCategory: categoryBenchmark ? categoryBenchmark.category : "",
      verifiedMax: verifiedMax
    };
  }

  global.MomentSeoEvaluation = Object.freeze({
    version: VERSION,
    evaluate: evaluate,
    optionalNumber: optionalNumber
  });
}(typeof window !== "undefined" ? window : globalThis));
