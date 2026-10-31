// 시험용 가짜 페이지 상태(스마트스토어 __PRELOADED_STATE__ 모양을 흉내 낸 것). 실제 네이버 페이지는 열지 않는다.
// 번호는 시제품 시험 페이지(~/.config/momentinsight/n30-group/option-fill/test/*.html)에서 가져온 공개 상품번호 모양이다.

export const ISHELL_CURRENT = "12356459438";
export const ISHELL_URL = `https://smartstore.naver.com/i_shell/products/${ISHELL_CURRENT}`;
export const DECASA_CURRENT = "13744370949";
export const DECASA_URL = `https://smartstore.naver.com/decasa/products/${DECASA_CURRENT}`;

// 개인정보처럼 보이는 값(진단·화면에 나오면 안 됨).
export const PRIVATE_VALUES = ["a@b.c", "010-1234-5678", "홍길동", "98765432101", "12345678901"];

export const ISHELL_OPTION_IDS = [
  "11463197546", "11463197547", "11463197548", "11463197549", "11463197550", "11463197551", "11463197552",
  "11463197553", "11463197554", "11463197555", "11463197557", "11463197558", "11463197560", "11463197561",
  "11463197562", "11463197564", "11463197565", "11525010693", "12356459439", "12356459440", "12356459441",
  "13810502838", "19999999991",
];

function relatedList(count, withCurrent) {
  const list = withCurrent ? [{ productNo: Number(withCurrent), name: "x" }] : [];
  for (let index = 0; index < count; index += 1) list.push({ productNo: 17000000000 + index, name: `관련${index}` });
  return list;
}

// 그룹 목록이 객체 목록(번호는 숫자형)이고 이름이 항목에 바로 있는 페이지 + 추천·관련 목록·회원 정보가 섞임.
export function groupObjectState() {
  return {
    product: { A: { productNo: Number(ISHELL_CURRENT), name: "아이쉘 대표", channel: { channelName: "아이쉘" } } },
    groupProduct: {
      groupProductNo: 88888888,
      products: [
        { productNo: Number(ISHELL_CURRENT), name: "아이폰17 사생활보호" },
        ...ISHELL_OPTION_IDS.map((id, index) => ({ productNo: Number(id), name: `옵션 ${index}` })),
      ],
    },
    // 관련 상품 목록은 지금 상품을 포함하고 그룹 목록보다 커도 고르면 안 된다.
    relatedProducts: { list: relatedList(40, ISHELL_CURRENT) },
    recommend: { items: Array.from({ length: 8 }, (_, index) => ({ productNo: 16000000000 + index, name: `추천${index}` })) },
    user: { memberNo: 12345678901, email: "a@b.c" },
  };
}

// 그룹 목록이 숫자만 든 목록(글자형 번호)이고, 같은 부모 아래 같은 길이의 이름 목록이 있음.
export function groupNumberArrayState({ withNames = true } = {}) {
  const ids = [DECASA_CURRENT, "13744375116", "13744387323", "13744387324"];
  const group = { groupId: 777, productNos: ids, statusCodes: ids.map(() => "SALE") };
  if (withNames) group.optionNames = ["수건 대표", "수건 1", "수건 2", "수건 3"];
  return { product: { A: { productNo: Number(DECASA_CURRENT) } }, productGroup: group };
}

// 이름이 항목 안 1~2단계 묶음에 들어 있음. 스토어 묶음(channel)의 이름은 옵션 이름으로 쓰면 안 된다.
export function groupNestedNameState() {
  return {
    groupInfo: {
      members: [
        { channelProductNo: DECASA_CURRENT, channel: { name: "드까사 스토어" }, option: { valueName: "화이트" } },
        { channelProductNo: "13744387322", channel: { name: "드까사 스토어" }, detail: { label: { text: "그레이 세트" } } },
        { channelProductNo: "13744387325", channel: { name: "드까사 스토어" } },
      ],
    },
  };
}

// 그룹 목록은 있지만 지금 상품번호가 없음(시제품 fake-members).
export function membersWithoutCurrentState() {
  return {
    product: { A: { productNo: Number(DECASA_CURRENT) } },
    groupInfo: {
      members: ["13744375116", "13744387323", "13744387324", "13744387326"].map((id, index) => ({ channelProductNo: Number(id), name: `수건 ${index}` })),
    },
    related: { list: relatedList(30, DECASA_CURRENT) },
    memberInfo: { memberNo: 98765432101, nickname: "홍길동" },
    groupStatus: "010-1234-5678",
  };
}

// 그룹 표시가 아예 없음(시제품 fake-nogroup) — 추천 목록에 지금 상품이 들어 있어도 못 찾음이어야 한다.
export function noGroupState() {
  return {
    product: { A: { productNo: Number(DECASA_CURRENT), name: "드까사" } },
    recommend: { items: [Number(DECASA_CURRENT), 16000000000, 16000000001, 16000000002].map((productNo) => ({ productNo })) },
  };
}

// 추천 구역 안에 group 이 든 키가 있어도 그 목록은 고르지 않는다.
export function recommendedGroupState() {
  const state = groupObjectState();
  state.recommendGroup = { products: relatedList(60, ISHELL_CURRENT) };
  return state;
}

// 지금 상품 포함 count 칸짜리 그룹 목록(글자형 번호).
export function groupOfSize(count, current = ISHELL_CURRENT) {
  const ids = [current];
  for (let index = 1; index < count; index += 1) ids.push(String(20000000000 + index));
  return { groupProduct: { products: ids.map((id) => ({ productNo: id, name: `옵션 ${id.slice(-3)}` })) } };
}

// 같은 부모 아래 나란한 칸(F4): 채널 번호(주소 번호) 목록 옆에 같은 길이의 원상품 번호 목록(번호 체계가 달라 지금 상품 없음).
// 이름 목록이 함께 있으면 이름도 짝지어야 한다. 원상품 번호 목록은 그룹이 나뉜 조각이 아니다.
export const PARALLEL_CHANNEL_IDS = [ISHELL_CURRENT, "11463197546", "11463197547", "11463197548"];
export const PARALLEL_ORIGINAL_IDS = ["10000000001", "10000000002", "10000000003", "10000000004"];
export function groupParallelColumnsState({ withNames = true } = {}) {
  const groupProduct = { channelProductNos: [...PARALLEL_CHANNEL_IDS], originalProductNos: [...PARALLEL_ORIGINAL_IDS] };
  if (withNames) groupProduct.optionNames = ["블랙", "화이트", "레드", "블루"];
  return { product: { A: { productNo: Number(ISHELL_CURRENT) } }, groupProduct };
}
