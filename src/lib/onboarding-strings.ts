/**
 * Everything a vendor reads on their onboarding link, in English and Vietnamese, in one structure. `Dict` is the
 * contract: a key missing from either language is a type error, and onboarding-strings.test.ts checks the same at
 * runtime. The Vietnamese needs a native speaker's read before the demo video (docs/UI_NOTES.md).
 *
 * The engine (vendors.ts) throws English sentences; classifyOnboardingError() turns each into a code, so the page can
 * show it in the vendor's language next to the field it is about.
 */

export type Lang = "en" | "vi";

/** Error codes the vendor can see. `generic` is the fallback for anything not listed. */
export type ErrorCode =
  | "nameRequired"
  | "noWayToPay"
  | "noWayToPayStellar"
  | "emailInvalid"
  | "paypalInvalid"
  | "stellarInvalid"
  | "phoneInvalid"
  | "taxIdInvalid"
  | "accountNumberInvalid"
  | "bankNeedsDetails"
  | "bankNeedsCountry"
  | "bankCodeInvalid"
  | "bankCurrencyInvalid"
  | "railNeedsPaypal"
  | "railNeedsStellar"
  | "railNeedsBank"
  | "tooLong"
  | "linkInvalid"
  | "linkUsed"
  | "linkExpired"
  | "openYourLink"
  | "generic";

export type Dict = {
  pageTitle: string;
  skip: string;
  sentWith: string;
  switchTo: string;
  heading: (business: string) => string;
  known: (name: string) => string;
  unknown: string;
  trust: (business: string) => string;
  confirm: string;
  once: (date: string) => string;
  linkUnavailable: string;
  // Form
  aboutYou: string;
  nameLabel: string;
  required: string;
  whatYouDo: string;
  country: string;
  contactEmail: string;
  contactEmailHint: string;
  phone: string;
  taxIdVn: string;
  taxIdOther: string;
  paidAs: string;
  choose: string;
  individual: string;
  business: string;
  wherePaid: string;
  giveOne: string;
  paypalEmail: string;
  paypalEmailHint: string;
  stellar: string;
  accountNumber: string;
  bank: string;
  bankCode: string;
  accountHolder: string;
  bankCountry: string;
  bankCurrency: string;
  example: (sample: string) => string;
  preferredRail: string;
  noPreference: string;
  wise: string;
  bankFile: string;
  send: string;
  saving: string;
  roles: Record<string, string>;
  countries: Record<string, string>;
  // Errors
  errorTitle: (n: number) => string;
  errors: Record<ErrorCode, string>;
  // Confirmation
  sentTitle: string;
  sentBody: string;
  sentTo: (business: string) => string;
  canClose: string;
};

const EN: Dict = {
  pageTitle: "Your payment details",
  skip: "Skip to content",
  sentWith: "Sent with Checkrail Pay",
  switchTo: "Tiếng Việt",
  heading: (b) => `Payment details for ${b}`,
  known: (n) => `${n}, tell us where you want to be paid.`,
  unknown: "Tell us who you are and where you want to be paid.",
  trust: (b) => `Only ${b || "the business"} sees these details, and a bank account number is stored encrypted.`,
  confirm: "The business confirms them with you, for example by phone, before sending any money.",
  once: (d) => `This link works once and expires on ${d}.`,
  linkUnavailable: "Link not available",
  aboutYou: "About you",
  nameLabel: "Your name or business name",
  required: "required",
  whatYouDo: "What you do",
  country: "Country",
  contactEmail: "Contact email",
  contactEmailHint: "How the business reaches you. Not where you are paid.",
  phone: "Phone, with country code",
  taxIdVn: "Tax code (MST) or ID number (CCCD), optional",
  taxIdOther: "Tax ID (TIN), optional",
  paidAs: "I am paid as",
  choose: "Choose",
  individual: "An individual",
  business: "A business",
  wherePaid: "Where you want to be paid",
  giveOne: "Give at least one. The business will confirm these with you before the first payment.",
  paypalEmail: "PayPal email",
  paypalEmailHint: "The email your PayPal account uses.",
  stellar: "Stellar account (public key)",
  accountNumber: "Bank account number",
  bank: "Bank",
  bankCode: "Bank code",
  accountHolder: "Name on the account",
  bankCountry: "Bank country",
  bankCurrency: "Bank currency",
  example: (s) => `e.g. ${s}`,
  preferredRail: "Preferred way to be paid",
  noPreference: "No preference",
  wise: "Bank transfer through Wise",
  bankFile: "Bank transfer, domestic file (Vietnam)",
  send: "Send my details",
  saving: "Saving",
  roles: { guide: "Guide", driver: "Driver", homestay: "Homestay", hotel: "Hotel", creator: "Creator", supplier: "Supplier", contractor: "Contractor" },
  countries: { VN: "Vietnam", PH: "Philippines", TH: "Thailand", US: "United States", CA: "Canada", GB: "United Kingdom" },
  errorTitle: (n) => `Not sent yet. Fix ${n === 1 ? "this" : `these ${n} things`}:`,
  errors: {
    nameRequired: "Enter your name or business name.",
    // The form only has a Stellar field for some vendors (the Philippines), so the message names only what is on screen.
    noWayToPay: "Give at least one way to be paid: a PayPal email or a bank account number.",
    noWayToPayStellar: "Give at least one way to be paid: a PayPal email, a Stellar account or a bank account number.",
    emailInvalid: "This email does not look right. Example: name@company.com",
    paypalInvalid: "This PayPal email does not look right.",
    stellarInvalid: "A Stellar public key starts with G and has 56 letters and digits.",
    phoneInvalid: "Use digits only, with the country code, like +84 912 345 678.",
    taxIdInvalid: "A tax ID uses letters, digits and dashes, 5 to 20 characters.",
    accountNumberInvalid: "An account number has 6 to 20 digits.",
    bankNeedsDetails: "With an account number, also choose the bank and enter the name on the account.",
    bankNeedsCountry: "A bank account needs its country and currency.",
    bankCodeInvalid: "A bank code uses letters and digits only.",
    bankCurrencyInvalid: "A currency is three letters, like VND.",
    railNeedsPaypal: "You chose PayPal as your preferred way, but gave no PayPal email.",
    railNeedsStellar: "You chose Stellar as your preferred way, but gave no Stellar account.",
    railNeedsBank: "You chose a bank transfer as your preferred way, but gave no account number.",
    tooLong: "This is too long. Please shorten it.",
    linkInvalid: "This link is not valid.",
    linkUsed: "This link has already been used. Ask the business for a new one if you need to change your details again.",
    linkExpired: "This link has expired. Ask the business for a new one.",
    openYourLink: "Open the link you were sent to submit your details.",
    generic: "Your details were not sent. Check them and try again.",
  },
  sentTitle: "Your details were sent",
  sentBody: "Thank you. The business confirms them with you before the first payment.",
  sentTo: (b) => `Sent to ${b || "the business"}.`,
  canClose: "You can close this page.",
};

const VI: Dict = {
  pageTitle: "Thông tin nhận tiền của bạn",
  skip: "Chuyển đến nội dung",
  sentWith: "Gửi qua Checkrail Pay",
  switchTo: "English",
  heading: (b) => `Thông tin nhận tiền cho ${b}`,
  known: (n) => `${n}, vui lòng cho biết bạn muốn nhận tiền ở đâu.`,
  unknown: "Vui lòng cho biết bạn là ai và muốn nhận tiền ở đâu.",
  trust: (b) => `Chỉ ${b || "doanh nghiệp"} xem được thông tin này, và số tài khoản ngân hàng được lưu dưới dạng mã hóa.`,
  confirm: "Trước khi chuyển tiền, doanh nghiệp sẽ xác nhận lại với bạn, có thể qua điện thoại.",
  once: (d) => `Đường dẫn này chỉ dùng được một lần và hết hạn vào ngày ${d}.`,
  linkUnavailable: "Đường dẫn không dùng được",
  aboutYou: "Về bạn",
  nameLabel: "Tên của bạn hoặc tên cơ sở kinh doanh",
  required: "bắt buộc",
  whatYouDo: "Bạn làm gì",
  country: "Quốc gia",
  contactEmail: "Email liên hệ",
  contactEmailHint: "Để doanh nghiệp liên hệ với bạn. Không phải nơi nhận tiền.",
  phone: "Số điện thoại, kèm mã quốc gia",
  taxIdVn: "Mã số thuế (MST) hoặc số CCCD, không bắt buộc",
  taxIdOther: "Mã số thuế (TIN), không bắt buộc",
  paidAs: "Tôi nhận tiền với tư cách",
  choose: "Chọn",
  individual: "Cá nhân",
  business: "Doanh nghiệp",
  wherePaid: "Bạn muốn nhận tiền ở đâu",
  giveOne: "Điền ít nhất một cách. Doanh nghiệp sẽ xác nhận lại với bạn trước lần thanh toán đầu tiên.",
  paypalEmail: "Email PayPal",
  paypalEmailHint: "Email của tài khoản PayPal sẽ nhận tiền.",
  stellar: "Tài khoản Stellar (khóa công khai)",
  accountNumber: "Số tài khoản ngân hàng",
  bank: "Ngân hàng",
  bankCode: "Mã ngân hàng",
  accountHolder: "Tên chủ tài khoản",
  bankCountry: "Quốc gia của ngân hàng",
  bankCurrency: "Loại tiền",
  example: (s) => `ví dụ: ${s}`,
  preferredRail: "Cách nhận tiền mong muốn",
  noPreference: "Không có yêu cầu",
  wise: "Chuyển khoản qua Wise",
  bankFile: "Chuyển khoản trong nước (Việt Nam)",
  send: "Gửi thông tin",
  saving: "Đang gửi",
  roles: { guide: "Hướng dẫn viên", driver: "Tài xế", homestay: "Homestay", hotel: "Khách sạn", creator: "Sáng tạo nội dung", supplier: "Nhà cung cấp", contractor: "Nhà thầu" },
  countries: { VN: "Việt Nam", PH: "Philippines", TH: "Thái Lan", US: "Hoa Kỳ", CA: "Canada", GB: "Vương quốc Anh" },
  errorTitle: (n) => `Chưa gửi được. Vui lòng sửa ${n === 1 ? "mục này" : `${n} mục sau`}:`,
  errors: {
    nameRequired: "Vui lòng nhập tên của bạn hoặc tên cơ sở kinh doanh.",
    noWayToPay: "Vui lòng điền ít nhất một cách nhận tiền: email PayPal hoặc số tài khoản ngân hàng.",
    noWayToPayStellar: "Vui lòng điền ít nhất một cách nhận tiền: email PayPal, tài khoản Stellar hoặc số tài khoản ngân hàng.",
    emailInvalid: "Email này chưa đúng định dạng. Ví dụ: ten@congty.vn",
    paypalInvalid: "Email PayPal này chưa đúng định dạng.",
    stellarInvalid: "Khóa công khai Stellar bắt đầu bằng chữ G và gồm 56 ký tự.",
    phoneInvalid: "Số điện thoại chỉ gồm chữ số, kèm mã quốc gia, ví dụ +84 912 345 678.",
    taxIdInvalid: "Mã số thuế gồm chữ cái, chữ số và dấu gạch ngang, từ 5 đến 20 ký tự.",
    accountNumberInvalid: "Số tài khoản gồm từ 6 đến 20 chữ số.",
    bankNeedsDetails: "Khi nhập số tài khoản, vui lòng chọn ngân hàng và nhập tên chủ tài khoản.",
    bankNeedsCountry: "Tài khoản ngân hàng cần có quốc gia và loại tiền.",
    bankCodeInvalid: "Mã ngân hàng chỉ gồm chữ cái và chữ số.",
    bankCurrencyInvalid: "Loại tiền gồm ba chữ cái, ví dụ VND.",
    railNeedsPaypal: "Bạn chọn nhận tiền qua PayPal nhưng chưa nhập email PayPal.",
    railNeedsStellar: "Bạn chọn nhận tiền qua Stellar nhưng chưa nhập tài khoản Stellar.",
    railNeedsBank: "Bạn chọn nhận tiền qua chuyển khoản ngân hàng nhưng chưa nhập số tài khoản.",
    tooLong: "Nội dung này quá dài. Vui lòng rút gọn.",
    linkInvalid: "Đường dẫn này không hợp lệ.",
    linkUsed: "Đường dẫn này đã được sử dụng. Nếu cần thay đổi thông tin lần nữa, vui lòng xin doanh nghiệp một đường dẫn mới.",
    linkExpired: "Đường dẫn này đã hết hạn. Vui lòng xin doanh nghiệp một đường dẫn mới.",
    openYourLink: "Vui lòng mở lại đường dẫn bạn đã nhận để gửi thông tin.",
    generic: "Chưa gửi được thông tin của bạn. Vui lòng kiểm tra lại và thử lần nữa.",
  },
  sentTitle: "Đã gửi thông tin của bạn",
  sentBody: "Cảm ơn bạn. Trước lần thanh toán đầu tiên, doanh nghiệp sẽ xác nhận lại thông tin này với bạn.",
  sentTo: (b) => `Đã gửi tới ${b || "doanh nghiệp"}.`,
  canClose: "Bạn có thể đóng trang này.",
};

export const STRINGS: Record<Lang, Dict> = { en: EN, vi: VI };

/** The language a vendor sees: what the link asked for, else Vietnamese for a Vietnamese vendor, else English. */
export function resolveLang(asked: string | undefined, vendorCountry: string | null | undefined): Lang {
  return asked === "vi" || asked === "en" ? asked : vendorCountry === "VN" ? "vi" : "en";
}

/** The expiry with the month in words, "6 tháng 11 năm 2026", in Vietnam's time zone (UTC+7, no DST). English pages use formatDate. */
export function formatExpiryVi(iso: string): string {
  const local = new Date(new Date(iso).getTime() + 7 * 3_600_000);
  return `${local.getUTCDate()} tháng ${local.getUTCMonth() + 1} năm ${local.getUTCFullYear()}`;
}

/** The label for a Vietnamese bank in the list: "Vietcombank (VCB)", but just "BIDV" when the name is the code. */
export function bankOptionLabel(code: string, name: string): string {
  return name.trim().toUpperCase() === code.trim().toUpperCase() ? name : `${name} (${code})`;
}

/** Which form field an error belongs to, by the id the form gives it. */
export type ErrorField = "v-name" | "v-email" | "v-phone" | "v-taxid" | "v-pp" | "v-xlm" | "v-acct" | "v-bcode" | "v-holder" | "v-bc" | "v-bcur" | "v-rail";

export type OnboardingError = { code: ErrorCode; field: ErrorField | null };

const FIELD_FOR_NAME: Array<[RegExp, ErrorField]> = [
  [/^Name\b/, "v-name"],
  [/^Email\b/, "v-email"],
  [/^Phone\b/, "v-phone"],
  [/^Tax ID\b/, "v-taxid"],
  [/^PayPal email\b/, "v-pp"],
  [/^Stellar account\b/, "v-xlm"],
  [/^Account number\b/, "v-acct"],
  [/^Bank code\b/, "v-bcode"],
  [/^Account holder\b/, "v-holder"],
  [/^Bank country\b/, "v-bc"],
  [/^Bank currency\b/, "v-bcur"],
];

/**
 * The engine's English messages (vendors.ts validators and the link checks) as a code and the field they are about.
 * Anything unknown is `generic`: the vendor gets a sentence in their language, never the engine's English.
 */
export function classifyOnboardingError(message: string): OnboardingError {
  const m = message.trim();
  // First: "Bank currency must be at most 3 characters" would otherwise match the format rule for the same field.
  if (/ must be at most \d+ characters$/.test(m)) return { code: "tooLong", field: FIELD_FOR_NAME.find(([re]) => re.test(m))?.[1] ?? null };
  const rules: Array<[RegExp, ErrorCode, ErrorField | null]> = [
    [/^Name is required/, "nameRequired", "v-name"],
    [/^Give at least one way to pay/, "noWayToPay", "v-pp"],
    [/^Email does not look like/, "emailInvalid", "v-email"],
    [/^PayPal email does not look like/, "paypalInvalid", "v-pp"],
    [/^Stellar account must be/, "stellarInvalid", "v-xlm"],
    [/^Phone must be/, "phoneInvalid", "v-phone"],
    [/^Tax ID may use/, "taxIdInvalid", "v-taxid"],
    [/^Account number must be/, "accountNumberInvalid", "v-acct"],
    [/^A bank account number needs the bank code/, "bankNeedsDetails", "v-bcode"],
    [/^A bank account needs its country/, "bankNeedsCountry", "v-bc"],
    [/^Bank code is the bank/, "bankCodeInvalid", "v-bcode"],
    [/^Bank currency must be/, "bankCurrencyInvalid", "v-bcur"],
    [/^Preferred rail is PayPal/, "railNeedsPaypal", "v-rail"],
    [/^Preferred rail is Stellar/, "railNeedsStellar", "v-rail"],
    [/^Preferred rail pays a bank account/, "railNeedsBank", "v-rail"],
    [/^This link is not valid/, "linkInvalid", null],
    [/^This link has already been used/, "linkUsed", null],
    [/^This link has expired/, "linkExpired", null],
    [/^Open your link to submit/, "openYourLink", null],
  ];
  for (const [re, code, field] of rules) if (re.test(m)) return { code, field };
  return { code: "generic", field: null };
}

/** The link-page reasons from lookupInvite() as codes (the token page already knows the language). */
export function linkReasonCode(reason: string): ErrorCode {
  const c = classifyOnboardingError(reason).code;
  return c === "linkUsed" || c === "linkExpired" ? c : "linkInvalid";
}

type Entered = { name: string; paypalEmail: string; stellarAccount: string; bankAccountNumber: string };

/**
 * What can be caught before anything is sent: no name (for a new vendor), no way to be paid. The server checks again
 * and says the rest; this only lets one pass list both problems at once.
 */
export function precheckOnboarding(v: Entered, needsName: boolean): OnboardingError[] {
  const out: OnboardingError[] = [];
  if (needsName && !v.name.trim()) out.push({ code: "nameRequired", field: "v-name" });
  if (!v.paypalEmail.trim() && !v.stellarAccount.trim() && !v.bankAccountNumber.trim()) out.push({ code: "noWayToPay", field: "v-pp" });
  return out;
}

/** The message for a code on a form that may or may not have a Stellar field: never names a field the vendor cannot see. */
export function errorText(t: Dict, code: ErrorCode, hasStellarField: boolean): string {
  return code === "noWayToPay" && hasStellarField ? t.errors.noWayToPayStellar : t.errors[code];
}
