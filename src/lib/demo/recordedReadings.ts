/**
 * Claude's readings of the six opening demo requests, recorded from a live run (claude-sonnet-5-5, PayPal sandbox,
 * 28 Oct 2026) and replayed on the hosted demo so judges can see what the model reads and which tools it calls,
 * without a model call. On simulated rails the decision still comes from the rule-based reader and the deterministic
 * policy, but a replayed reading's confidence is the one policy checks (src/lib/ai/agent.ts, withRecordedConfidence),
 * so the page and the policy rule quote the same figure, except for the two marked reflectsLiveAccount. Internal request ids were removed from the text. Tool results are the stored 200-character previews.
 *
 * Two readings (JOB-HG4D-0921 and JOB-PAL3D-0927) found real PayPal sandbox payouts made on 12 Oct 2026 for the same
 * jobs: that is what the live account held when they were recorded, and the page says so. They are marked
 * reflectsLiveAccount: shown, but their confidence is not the one policy checks.
 */

export interface RecordedReading {
  sourceRef: string;
  vendorId: string;
  summary: string;
  confidence: number;
  flags: string[];
  missing: string[];
  notes: string[];
  model: string;
  readAt: string;
  toolCalls: Array<{ name: string; input: string; resultPreview: string }>;
  amountMinor: number;
  currency: string;
  /** The request text Claude read, exactly as the demo seeds it. A request with other words is not the one it read. */
  requestText: string;
  /** Claude read the repeat of a request already paid: it applies only when the reference is in the vendor's settled history. */
  onlyAsRepeat?: boolean;
  /**
   * The reading turned on the live PayPal sandbox account's own state (payouts made there on 12 Oct 2026 that this
   * demo's books do not hold). It is still shown, with its concerns, but its confidence is not handed to policy: the
   * page says "The rules did not see this run." for these. Using it would hold the demo's ready-to-pay requests.
   */
  reflectsLiveAccount?: boolean;
}

export const RECORDED_CLAUDE_READINGS: RecordedReading[] = [
  {
    "requestText": "Hey can you pay Phuong Transport INV-2026-0152 today? Van for the Ha Giang 4-day loop (Sept 27 to 30), total $960. He needs it urgently for fuel on the next trip.",
    "sourceRef": "INV-2026-0152",
    "vendorId": "ven_phuong",
    "summary": "The operator asks to pay Phuong Transport USD 960 for INV-2026-0152, but the contract rate (USD 200 per vehicle-day) and the trip sheet (4 days) support only USD 800. The request is USD 160 over the evidence and also adds urgency pressure (\"today\", \"urgently for fuel\").",
    "confidence": 15,
    "flags": [
      "Amount mismatch: requested USD 960 but trip sheet HG-4D-0927 and contract (4 days x USD 200, driver and fuel included) support USD 800.00; USD 160 unexplained. No tolls were logged and there is no overnight surcharge.",
      "Urgency pressure: request asks for payment 'today' and says the vendor needs it urgently for fuel. Fuel is already included in the contract rate."
    ],
    "missing": [
      "Vendor invoice INV-2026-0152 (no invoice document attached) showing how USD 960 is made up"
    ],
    "notes": [
      "No prior payment of INV-2026-0152 found in vendor history or the last 30 days of PayPal transactions.",
      "Vendor history shows consistent USD 200/day rate (INV-2026-0117, -0129, -0138).",
      "Vendor is known (Vietcombank ****7781 on file, PayPal available); no change in payout details observed."
    ],
    "model": "claude-sonnet-5-5",
    "readAt": "2026-10-28T19:41:35.796Z",
    "toolCalls": [
      {
        "name": "lookup_vendor",
        "input": "{\"query\":\"Phuong Transport\"}",
        "resultPreview": "[{\"id\":\"ven_phuong\",\"name\":\"Phuong Transport\",\"country\":\"VN\",\"paypal\":true,\"stellar\":false,\"bank\":\"Vietcombank ****7781\",\"verifiedAt\":\"2026-08-14T09:00:00.000Z\"}]"
      },
      {
        "name": "read_evidence",
        "input": "{}",
        "resultPreview": "{\"records\":[{\"id\":\"evd_0fa81460cb8041ff\",\"kind\":\"contract\",\"label\":\"Transport agreement 2026 (Phuong)\",\"amountMinor\":20000,\"currency\":\"USD\",\"reference\":\"AGR-PHUONG-2026\",\"excerpt\":\"Rate: USD 200.00 pe"
      },
      {
        "name": "paypal_list_transactions",
        "input": "{}",
        "resultPreview": "{\"transaction_details\":[{\"transaction_info\":{\"transaction_id\":\"0BA03661BC855113S\",\"transaction_event_code\":\"T1900\",\"transaction_initiation_date\":\"2026-10-10T04:07:55Z\",\"transaction_updated_date\":\"2026"
      },
      {
        "name": "vendor_history",
        "input": "{\"vendorId\":\"ven_phuong\"}",
        "resultPreview": "[{\"sourceRef\":\"INV-2026-0138\",\"amountMinor\":60000,\"currency\":\"USD\",\"settledAt\":\"2026-10-16T19:36:39.485Z\",\"description\":\"Van hire, 3 days at USD 200/day\"},{\"sourceRef\":\"INV-2026-0129\",\"amountMinor\":10"
      }
    ],
    "amountMinor": 96000,
    "currency": "USD"
  },
  {
    "onlyAsRepeat": true,
    "requestText": "Invoice from Maria Santos. Guide fee for JOB-HG4D-0914, 4 days, USD 180. Payment to PayPal please.",
    "sourceRef": "JOB-HG4D-0914",
    "vendorId": "ven_maria",
    "summary": "Maria Santos invoices USD 180 for 4 days on JOB-HG4D-0914, which matches the trip sheet (4 x USD 45). However, vendor history shows this same job was already paid USD 180 on 2026-10-11, so this looks like a duplicate request.",
    "confidence": 10,
    "flags": [
      "JOB-HG4D-0914 already appears in Maria Santos's settled payment history (USD 180.00, settled 2026-10-11); this request may be a duplicate payment."
    ],
    "missing": [],
    "notes": [
      "Amount USD 180 matches the trip sheet (4 days at USD 45/day) and her usual 4-day rate.",
      "Vendor is known, with PayPal on file.",
      "Recent PayPal transactions show no payment tagged JOB-HG4D-0914. A USD 180 PayPal payment tagged JOB-HG4D-0921 is a different job reference. The earlier settlement may have gone via another payout method."
    ],
    "model": "claude-sonnet-5-5",
    "readAt": "2026-10-28T19:41:46.203Z",
    "toolCalls": [
      {
        "name": "lookup_vendor",
        "input": "{\"query\":\"Maria Santos\"}",
        "resultPreview": "[{\"id\":\"ven_maria\",\"name\":\"Maria Santos\",\"country\":\"PH\",\"paypal\":true,\"stellar\":true,\"bank\":\"BDO ****4417\",\"verifiedAt\":\"2026-08-14T09:00:00.000Z\"}]"
      },
      {
        "name": "read_evidence",
        "input": "{}",
        "resultPreview": "{\"records\":[{\"id\":\"evd_38ae2c87d2c34819\",\"kind\":\"job_sheet\",\"label\":\"Trip sheet HG-4D-0914\",\"amountMinor\":18000,\"currency\":\"USD\",\"reference\":\"JOB-HG4D-0914\",\"excerpt\":\"Departure HG-4D-0914, lead guide"
      },
      {
        "name": "paypal_list_transactions",
        "input": "{}",
        "resultPreview": "{\"transaction_details\":[{\"transaction_info\":{\"transaction_id\":\"0BA03661BC855113S\",\"transaction_event_code\":\"T1900\",\"transaction_initiation_date\":\"2026-10-10T04:07:55Z\",\"transaction_updated_date\":\"2026"
      },
      {
        "name": "vendor_history",
        "input": "{\"vendorId\":\"ven_maria\"}",
        "resultPreview": "[{\"sourceRef\":\"JOB-HG4D-0914\",\"amountMinor\":18000,\"currency\":\"USD\",\"settledAt\":\"2026-10-11T19:36:30.133Z\",\"description\":\"Lead guide, 4 days, trip HG-4D-0914 (JOB-HG4D-0914)\"},{\"sourceRef\":\"JOB-HG3D-09"
      }
    ],
    "amountMinor": 18000,
    "currency": "USD"
  },
  {
    "reflectsLiveAccount": true,
    "requestText": "Trip HG-4D-0921 closed. Lead guide Maria Santos, 4 days, USD 180 (JOB-HG4D-0921). Guest feedback 4.9. Release payment.",
    "sourceRef": "JOB-HG4D-0921",
    "vendorId": "ven_maria",
    "summary": "Maria Santos is a known vendor, and the USD 180.00 request matches the signed-off trip sheet (4 days × USD 45) and her usual 4-day rate. However, PayPal already shows a settled USD 180.00 payment from Checkrail Pay on 2026-10-12 with the note JOB-HG4D-0921, so this job may already have been paid.",
    "confidence": 25,
    "flags": [
      "Possible duplicate: a PayPal transaction on 2026-10-12 (ID 89H53479Y2386774R, USD 180.00, note 'JOB-HG4D-0921') already pays this job reference. It does not appear in the vendor's settled history, so confirm whether it was paid before releasing again.",
      "The payer_info on that PayPal transaction shows a different counterparty (John Doe, Hanoi, VN) rather than a clearly identified Maria Santos account. Confirm who received it."
    ],
    "missing": [],
    "notes": [
      "Amount matches the job sheet (USD 180.00) and prior 4-day trips (JOB-HG4D-0914, -0831, -0728 were each USD 180).",
      "Guest feedback score of 4.9 is noted in the request and does not affect the amount.",
      "Vendor has PayPal, Stellar and bank (BDO ****4417) on file; verified 2026-08-14."
    ],
    "model": "claude-sonnet-5-5",
    "readAt": "2026-10-28T19:41:58.362Z",
    "toolCalls": [
      {
        "name": "lookup_vendor",
        "input": "{\"query\":\"Maria Santos\"}",
        "resultPreview": "[{\"id\":\"ven_maria\",\"name\":\"Maria Santos\",\"country\":\"PH\",\"paypal\":true,\"stellar\":true,\"bank\":\"BDO ****4417\",\"verifiedAt\":\"2026-08-14T09:00:00.000Z\"}]"
      },
      {
        "name": "read_evidence",
        "input": "{}",
        "resultPreview": "{\"records\":[{\"id\":\"evd_00a4f34631bc4668\",\"kind\":\"job_sheet\",\"label\":\"Trip sheet HG-4D-0921\",\"amountMinor\":18000,\"currency\":\"USD\",\"reference\":\"JOB-HG4D-0921\",\"excerpt\":\"Departure HG-4D-0921, lead guide"
      },
      {
        "name": "paypal_list_transactions",
        "input": "{}",
        "resultPreview": "{\"transaction_details\":[{\"transaction_info\":{\"transaction_id\":\"0BA03661BC855113S\",\"transaction_event_code\":\"T1900\",\"transaction_initiation_date\":\"2026-10-10T04:07:55Z\",\"transaction_updated_date\":\"2026"
      },
      {
        "name": "vendor_history",
        "input": "{\"vendorId\":\"ven_maria\"}",
        "resultPreview": "[{\"sourceRef\":\"JOB-HG4D-0914\",\"amountMinor\":18000,\"currency\":\"USD\",\"settledAt\":\"2026-10-11T19:36:30.133Z\",\"description\":\"Lead guide, 4 days, trip HG-4D-0914 (JOB-HG4D-0914)\"},{\"sourceRef\":\"JOB-HG3D-09"
      }
    ],
    "amountMinor": 18000,
    "currency": "USD"
  },
  {
    "reflectsLiveAccount": true,
    "requestText": "Trip PAL-3D-0927 closed. Guide Ana Reyes, 3-day Palawan private, USD 750 (JOB-PAL3D-0927). Client extended one day; rate confirmed with ops. Release payment.",
    "sourceRef": "JOB-PAL3D-0927",
    "vendorId": "ven_ana",
    "summary": "Ana Reyes is owed USD 750.00 for the 3-day Palawan private trip. The amount matches the trip sheet (3 × USD 250) and her usual rate. However, PayPal already shows a USD 750 payment to ana.reyes@example.com referencing JOB-PAL3D-0927 (initiated 12 Oct, status pending), so this may be a duplicate.",
    "confidence": 30,
    "flags": [
      "JOB-PAL3D-0927 appears to have already been paid: PayPal transaction 878829956L370032P (USD 750.00 to ana.reyes@example.com, 12 Oct 2026, note 'JOB-PAL3D-0927') has status P (pending). Confirm whether it completed or failed before releasing another payment."
    ],
    "missing": [],
    "notes": [
      "Trip sheet shows 3 days at USD 250/day = USD 750, matching the request amount.",
      "Ops chat confirms the USD 250/day rate, approved by Daniel on 25 Sept. The request says the client extended by one day, but the trip sheet and amount already cover 3 days.",
      "Ana's prior payments: USD 750 for a 3-day trip (JOB-PAL3D-0822) and USD 500 for 2-day trips, so the rate is consistent with her history.",
      "Vendor on file with PayPal and a UnionBank account; no change in payout details observed."
    ],
    "model": "claude-sonnet-5-5",
    "readAt": "2026-10-28T19:42:10.430Z",
    "toolCalls": [
      {
        "name": "lookup_vendor",
        "input": "{\"query\":\"Ana Reyes\"}",
        "resultPreview": "[{\"id\":\"ven_ana\",\"name\":\"Ana Reyes\",\"country\":\"PH\",\"paypal\":true,\"stellar\":false,\"bank\":\"UnionBank ****0923\",\"verifiedAt\":\"2026-08-14T09:00:00.000Z\"}]"
      },
      {
        "name": "read_evidence",
        "input": "{}",
        "resultPreview": "{\"records\":[{\"id\":\"evd_d9cc134d68e140e0\",\"kind\":\"job_sheet\",\"label\":\"Trip sheet PAL-3D-0927\",\"amountMinor\":75000,\"currency\":\"USD\",\"reference\":\"JOB-PAL3D-0927\",\"excerpt\":\"Departure PAL-3D-0927, guide A"
      },
      {
        "name": "paypal_list_transactions",
        "input": "{}",
        "resultPreview": "{\"transaction_details\":[{\"transaction_info\":{\"transaction_id\":\"0BA03661BC855113S\",\"transaction_event_code\":\"T1900\",\"transaction_initiation_date\":\"2026-10-10T04:07:55Z\",\"transaction_updated_date\":\"2026"
      },
      {
        "name": "vendor_history",
        "input": "{\"vendorId\":\"ven_ana\"}",
        "resultPreview": "[{\"sourceRef\":\"JOB-PAL2D-0912\",\"amountMinor\":50000,\"currency\":\"USD\",\"settledAt\":\"2026-10-09T19:37:18.057Z\",\"description\":\"Guide fee, 2-day Palawan private trip PAL-2D-0912\"},{\"sourceRef\":\"JOB-PAL3D-08"
      }
    ],
    "amountMinor": 75000,
    "currency": "USD"
  },
  {
    "requestText": "Hoa don HS-1027 tu Linh Family Homestay (Du Gia): 12 khach x 2 dem x 450.000 VND, tong cong 10.800.000 VND. Departure HG-4D-1004. Chuyen khoan BIDV giup em.",
    "sourceRef": "HS-1027",
    "vendorId": "ven_linh",
    "summary": "Linh Family Homestay invoice HS-1027 asks for VND 10,800,000 (12 guests x 2 nights x VND 450,000) for departure HG-4D-1004. The amount matches the attached invoice, the vendor is known with BIDV ****2206 on file, and I found no earlier payment for this reference.",
    "confidence": 92,
    "flags": [],
    "missing": [],
    "notes": [
      "Past payments to this vendor were in USD at USD 18 per guest per night. VND 450,000 is roughly the same rate, so the rate is consistent. This invoice is in VND, paid by BIDV bank transfer.",
      "The BIDV account on file (****2206) is the payout method requested; no changed bank details.",
      "No PayPal transaction matches HS-1027 or this vendor. The recent PayPal payments are for other job references.",
      "The vendor history does not include HS-1027 or departure HG-4D-1004."
    ],
    "model": "claude-sonnet-5-5",
    "readAt": "2026-10-28T19:42:22.125Z",
    "toolCalls": [
      {
        "name": "lookup_vendor",
        "input": "{\"query\":\"Linh Family Homestay\"}",
        "resultPreview": "[{\"id\":\"ven_linh\",\"name\":\"Linh Family Homestay\",\"country\":\"VN\",\"paypal\":true,\"stellar\":false,\"bank\":\"BIDV ****2206\",\"verifiedAt\":\"2026-10-22T19:42:10.447Z\"}]"
      },
      {
        "name": "read_evidence",
        "input": "{}",
        "resultPreview": "{\"records\":[{\"id\":\"evd_ae305460b1424ee2\",\"kind\":\"invoice\",\"label\":\"Homestay invoice HS-1027\",\"amountMinor\":1080000000,\"currency\":\"VND\",\"reference\":\"HS-1027\",\"excerpt\":\"Linh Family Homestay, Du Gia. 12"
      },
      {
        "name": "vendor_history",
        "input": "{\"vendorId\":\"ven_linh\"}",
        "resultPreview": "[{\"sourceRef\":\"INV-2026-0140\",\"amountMinor\":32400,\"currency\":\"USD\",\"settledAt\":\"2026-10-17T19:36:48.651Z\",\"description\":\"Homestay accommodation: 9 guests x 2 nights x USD 18\"},{\"sourceRef\":\"INV-2026-0"
      },
      {
        "name": "paypal_list_transactions",
        "input": "{}",
        "resultPreview": "{\"transaction_details\":[{\"transaction_info\":{\"transaction_id\":\"0BA03661BC855113S\",\"transaction_event_code\":\"T1900\",\"transaction_initiation_date\":\"2026-10-10T04:07:55Z\",\"transaction_updated_date\":\"2026"
      }
    ],
    "amountMinor": 1080000000,
    "currency": "VND"
  },
  {
    "requestText": "Dao Mountain Lodge invoice INV-DML-1010 for the Cao Bang departure CB-3D-1012: 10 rooms, 2 nights, total USD 850. 50% deposit USD 425 now to hold the rooms, balance on arrival.",
    "sourceRef": "INV-DML-1010",
    "vendorId": "ven_dao",
    "summary": "Dao Mountain Lodge asks for a USD 425 deposit (50% of the USD 850 invoice INV-DML-1010) to hold 10 rooms for 2 nights. The invoice evidence matches the amount and the rate of USD 42.50 per room-night, which is the same as in past payments. I found no earlier payment of this invoice.",
    "confidence": 93,
    "flags": [],
    "missing": [],
    "notes": [
      "Rate USD 42.50 per room-night matches prior invoices INV-DML-0919 and INV-DML-0803.",
      "No INV-DML-1010 payment in vendor history or recent PayPal transactions.",
      "Balance of USD 425 is due on arrival."
    ],
    "model": "claude-sonnet-5-5",
    "readAt": "2026-10-28T19:42:33.125Z",
    "toolCalls": [
      {
        "name": "lookup_vendor",
        "input": "{\"query\":\"Dao Mountain Lodge\"}",
        "resultPreview": "[{\"id\":\"ven_dao\",\"name\":\"Dao Mountain Lodge\",\"country\":\"VN\",\"paypal\":true,\"stellar\":false,\"bank\":\"Techcombank ****5519\",\"verifiedAt\":\"2026-08-14T09:00:00.000Z\"}]"
      },
      {
        "name": "read_evidence",
        "input": "{}",
        "resultPreview": "{\"records\":[{\"id\":\"evd_448b590837f645f7\",\"kind\":\"invoice\",\"label\":\"Dao Mountain Lodge invoice INV-DML-1010\",\"amountMinor\":85000,\"currency\":\"USD\",\"reference\":\"INV-DML-1010\",\"excerpt\":\"Dao Mountain Lodg"
      },
      {
        "name": "paypal_list_transactions",
        "input": "{}",
        "resultPreview": "{\"transaction_details\":[{\"transaction_info\":{\"transaction_id\":\"0BA03661BC855113S\",\"transaction_event_code\":\"T1900\",\"transaction_initiation_date\":\"2026-10-10T04:07:55Z\",\"transaction_updated_date\":\"2026"
      },
      {
        "name": "vendor_history",
        "input": "{\"vendorId\":\"ven_dao\"}",
        "resultPreview": "[{\"sourceRef\":\"INV-DML-0919\",\"amountMinor\":68000,\"currency\":\"USD\",\"settledAt\":\"2026-10-20T19:37:25.918Z\",\"description\":\"Invoice INV-DML-0919: 8 rooms, 2 nights\"},{\"sourceRef\":\"INV-DML-0803\",\"amountMin"
      }
    ],
    "amountMinor": 42500,
    "currency": "USD"
  }
];

/** The recorded reading for a demo request, matched by vendor and reference. */
export function recordedReadingFor(vendorId: string | null | undefined, sourceRef: string | null | undefined): RecordedReading | null {
  if (!vendorId || !sourceRef) return null;
  return RECORDED_CLAUDE_READINGS.find((r) => r.vendorId === vendorId && r.sourceRef === sourceRef) ?? null;
}
