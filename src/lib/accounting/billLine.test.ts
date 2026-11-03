import { describe, it, expect } from "vitest";
import { accountCodeFor, accountLabel, accountName } from "./billLine";

describe("default account codes by role", () => {
  it("puts guides on 310, transport and vehicle or motorbike rental on 320, accommodation on 325", () => {
    expect(accountCodeFor("guide", null)).toBe("310");
    expect(accountCodeFor("driver", null)).toBe("320");
    expect(accountCodeFor("homestay", null)).toBe("325");
    expect(accountCodeFor("hotel", null)).toBe("325");
    expect(accountCodeFor("creator", null)).toBe("400");
    expect(accountCodeFor("supplier", null)).toBe("429");
  });
  it("keeps the vendor's own code and the prepayment account for an advance", () => {
    expect(accountCodeFor("driver", "455 Boat charters")).toBe("455");
    expect(accountCodeFor("driver", null, "advance")).toBe("620");
  });
  it("names 320 Transport and vehicle hire, in the same style as the other labels", () => {
    expect(accountLabel("320")).toBe("320 Cost of Goods Sold: Transport and vehicle hire");
    expect(accountLabel("310")).toBe("310 Cost of Goods Sold: Contract labour");
    expect(accountName("325")).toBe("Cost of Goods Sold: Accommodation");
    expect(accountName("999")).toBe("");
  });
});
