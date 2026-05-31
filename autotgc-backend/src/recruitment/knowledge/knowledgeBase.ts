/**
 * Curated knowledge base for grounding the AI recruitment-consultant agent
 * (customer: Thanh Giang Conincon — Vietnamese labor-export / XKLĐ company).
 *
 * IMPORTANT — honesty / grounding note:
 * This module is NOT a fine-tuned or "trained" AI model. It is a hand-curated
 * set of factual, PUBLIC, general company/market/visa/industry/FAQ context. The
 * RecruitmentConsultantAgent RETRIEVES the most relevant entries and uses them
 * to ground its prompt (and the deterministic fallback answer). No private data,
 * no invented exact fees, and no guarantees are encoded here — specifics that
 * vary by order are phrased as "tùy đơn hàng / liên hệ tư vấn".
 *
 * Content language is Vietnamese (the product language). Each entry maps 1:1 to
 * a `KnowledgeEntry` row (category | title | content | tags | market?), seeded
 * idempotently by the stable key `category + title`.
 */

/** Allowed knowledge categories (mirrors KnowledgeEntry.category). */
export type KnowledgeCategory =
  | 'company'
  | 'market'
  | 'visa'
  | 'industry'
  | 'faq'
  | 'process'
  | 'branch';

/** A single curated seed record (shape of a KnowledgeEntry, sans db columns). */
export interface KnowledgeSeed {
  category: KnowledgeCategory;
  title: string;
  content: string;
  tags: string[];
  /** Optional market tag: japan | germany | korea | taiwan | domestic. */
  market?: string;
}

/** Public company identity used across prompts (no secrets — public contact info). */
export const COMPANY_IDENTITY = {
  name: 'Thanh Giang Conincon',
  founded: 2011,
  hq: 'Hà Nội',
  hotline: ['091.858.2233', '096.450.2233 (Zalo)'],
  email: 'aoikawa@thanhgiang.com.vn',
  branchesNote: '15+ chi nhánh trên toàn quốc',
} as const;

/**
 * The curated dataset. ~35 entries spanning company, markets, visa tracks,
 * industries, the recruitment process, branches, and candidate FAQs.
 */
export const KNOWLEDGE_BASE: readonly KnowledgeSeed[] = [
  // ---- Company ------------------------------------------------------------
  {
    category: 'company',
    title: 'Giới thiệu Thanh Giang Conincon',
    content:
      'Thanh Giang Conincon là công ty hoạt động trong lĩnh vực xuất khẩu lao động (XKLĐ), ' +
      'thành lập năm 2011, trụ sở chính tại Hà Nội với hơn 15 chi nhánh trên toàn quốc. ' +
      'Công ty đưa người lao động Việt Nam đi làm việc ở nước ngoài, tập trung chủ yếu thị ' +
      'trường Nhật Bản, đồng thời triển khai các chương trình Đức, Hàn Quốc, Đài Loan, du học ' +
      'và đào tạo tiếng Nhật. Mọi thông tin về điều kiện và chi phí cụ thể tùy theo từng đơn hàng, ' +
      'vui lòng liên hệ tư vấn để được hỗ trợ chính xác.',
    tags: ['thanh giang', 'công ty', 'xkld', 'giới thiệu', 'xuất khẩu lao động'],
  },
  {
    category: 'company',
    title: 'Thông tin liên hệ và kênh tư vấn',
    content:
      'Người lao động có thể liên hệ Thanh Giang Conincon qua hotline 091.858.2233 hoặc ' +
      '096.450.2233 (hỗ trợ Zalo), email aoikawa@thanhgiang.com.vn, hoặc đến trực tiếp các ' +
      'chi nhánh. Đội ngũ tư vấn hỗ trợ chọn thị trường, ngành nghề, loại visa phù hợp với độ tuổi, ' +
      'trình độ và nguyện vọng của từng ứng viên. Đây là các kênh liên hệ công khai của công ty.',
    tags: ['liên hệ', 'hotline', 'zalo', 'email', 'tư vấn'],
  },
  {
    category: 'company',
    title: 'Lĩnh vực hoạt động và dịch vụ',
    content:
      'Dịch vụ của công ty gồm: phái cử lao động đi Nhật Bản theo ba diện chính (Kỹ năng đặc định, ' +
      'Kỹ sư - Nhân viên, Thực tập sinh), XKLĐ Đức, lao động Hàn Quốc (EPS), Đài Loan, du học Nhật Bản, ' +
      'đào tạo tiếng Nhật và giới thiệu việc làm trong nước. Lộ trình và quyền lợi cụ thể phụ thuộc ' +
      'chương trình và đơn hàng được tư vấn trực tiếp.',
    tags: ['dịch vụ', 'chương trình', 'nhật bản', 'đức', 'hàn quốc', 'đài loan', 'du học'],
  },

  // ---- Markets ------------------------------------------------------------
  {
    category: 'market',
    title: 'Thị trường Nhật Bản',
    content:
      'Nhật Bản là thị trường trọng điểm của Thanh Giang. Người lao động có thể đi theo ba diện chính: ' +
      'Thực tập sinh kỹ năng (TTS), Kỹ năng đặc định (Tokutei/SSW) và Kỹ sư - Nhân viên (diện kỹ sư). ' +
      'Yêu cầu phổ biến gồm độ tuổi phù hợp, sức khỏe đạt, và trình độ tiếng Nhật theo từng đơn (thường ' +
      'từ N5 đến N3 tùy ngành). Mức lương tham khảo dao động tùy đơn hàng và tỷ giá; liên hệ tư vấn để biết chi tiết.',
    tags: ['nhật bản', 'japan', 'tokutei', 'tts', 'kỹ sư', 'thị trường'],
    market: 'japan',
  },
  {
    category: 'market',
    title: 'Thị trường Đức (XKLĐ Đức)',
    content:
      'Chương trình XKLĐ Đức hướng tới các ngành thiếu nhân lực như điều dưỡng, nhà hàng - khách sạn ' +
      'và kỹ thuật. Ứng viên thường cần học tiếng Đức (trình độ theo yêu cầu chương trình, thường B1-B2 ' +
      'cho điều dưỡng) và có lộ trình đào tạo trước khi xuất cảnh. Điều kiện, học phí và thời gian đào tạo ' +
      'tùy chương trình; vui lòng liên hệ tư vấn.',
    tags: ['đức', 'germany', 'điều dưỡng', 'tiếng đức', 'thị trường'],
    market: 'germany',
  },
  {
    category: 'market',
    title: 'Thị trường Hàn Quốc (EPS)',
    content:
      'Lao động Hàn Quốc chủ yếu theo chương trình cấp phép việc làm EPS, tập trung các nhóm ngành sản xuất ' +
      'chế tạo, nông nghiệp, xây dựng và ngư nghiệp. Ứng viên thường phải thi tiếng Hàn (EPS-TOPIK) và đáp ứng ' +
      'điều kiện độ tuổi, sức khỏe. Chỉ tiêu và kỳ thi phụ thuộc thông báo từng năm; liên hệ tư vấn để cập nhật.',
    tags: ['hàn quốc', 'korea', 'eps', 'topik', 'thị trường'],
    market: 'korea',
  },
  {
    category: 'market',
    title: 'Thị trường Đài Loan',
    content:
      'Đài Loan là thị trường có chi phí và yêu cầu đầu vào tương đối linh hoạt, phù hợp lao động phổ thông ' +
      'trong các ngành sản xuất công nghiệp, xây dựng, chăm sóc và nông nghiệp. Thời gian xử lý hồ sơ thường ' +
      'nhanh hơn so với một số thị trường khác. Điều kiện và mức lương cụ thể tùy đơn hàng.',
    tags: ['đài loan', 'taiwan', 'sản xuất', 'lao động phổ thông', 'thị trường'],
    market: 'taiwan',
  },
  {
    category: 'market',
    title: 'Du học Nhật Bản và đào tạo tiếng Nhật',
    content:
      'Ngoài phái cử lao động, công ty hỗ trợ du học Nhật Bản và đào tạo tiếng Nhật từ cơ bản. Du học là lộ ' +
      'trình vừa học vừa làm thêm hợp pháp trong giới hạn cho phép, phù hợp bạn trẻ muốn nâng cao trình độ. ' +
      'Yêu cầu hồ sơ học vấn, chứng minh tài chính và trình độ tiếng theo từng trường; liên hệ tư vấn để biết chi tiết.',
    tags: ['du học', 'tiếng nhật', 'nhật bản', 'student', 'đào tạo'],
    market: 'japan',
  },

  // ---- Visa tracks --------------------------------------------------------
  {
    category: 'visa',
    title: 'Diện Kỹ năng đặc định (Tokutei / SSW)',
    content:
      'Kỹ năng đặc định (Tokutei Ginou / Specified Skilled Worker) dành cho lao động đã có kỹ năng và tiếng ' +
      'Nhật cơ bản, cho phép làm việc tại nhiều ngành Nhật Bản đang thiếu hụt. Ứng viên thường cần đạt kỳ thi ' +
      'kỹ năng ngành và tiếng Nhật (thường tương đương N4 trở lên hoặc JFT-Basic). Diện này thường có mức lương ' +
      'và quyền lợi tốt hơn thực tập sinh và có khả năng gia hạn theo quy định. Điều kiện cụ thể tùy đơn hàng.',
    tags: ['tokutei', 'ssw', 'kỹ năng đặc định', 'visa', 'n4', 'nhật bản'],
    market: 'japan',
  },
  {
    category: 'visa',
    title: 'Diện Kỹ sư - Nhân viên (Engineer)',
    content:
      'Diện Kỹ sư - Nhân viên dành cho ứng viên tốt nghiệp cao đẳng/đại học đúng chuyên ngành (cơ khí, CNTT, ' +
      'xây dựng, điện...) làm việc dài hạn tại Nhật theo đúng lĩnh vực. Yêu cầu bằng cấp phù hợp và tiếng Nhật ' +
      'theo đơn (thường N3 trở lên). Đây là diện ổn định, có lộ trình gia hạn và định cư lâu dài; chi tiết tùy đơn hàng.',
    tags: ['kỹ sư', 'engineer', 'visa', 'đại học', 'n3', 'nhật bản'],
    market: 'japan',
  },
  {
    category: 'visa',
    title: 'Diện Thực tập sinh kỹ năng (TTS / Trainee)',
    content:
      'Thực tập sinh kỹ năng (Ginou Jisshu) là lộ trình phổ biến cho lao động phổ thông sang Nhật học và làm ' +
      'việc theo hợp đồng (thường 1-3 năm, có thể gia hạn theo quy định). Yêu cầu đầu vào về tiếng Nhật thường ' +
      'thấp hơn (khoảng N5-N4) và được đào tạo trước khi xuất cảnh. Là bước khởi đầu nhiều người chọn để sau này ' +
      'chuyển lên diện Kỹ năng đặc định. Điều kiện và chi phí tùy đơn hàng.',
    tags: ['thực tập sinh', 'tts', 'trainee', 'visa', 'n5', 'n4', 'nhật bản'],
    market: 'japan',
  },
  {
    category: 'visa',
    title: 'Diện Du học sinh (Student)',
    content:
      'Du học sinh sang Nhật theo visa du học, vừa học tại trường tiếng/chuyên môn vừa được làm thêm hợp pháp ' +
      'trong giới hạn giờ cho phép. Phù hợp ứng viên trẻ, có nền tảng học vấn và mong muốn lộ trình dài hạn. ' +
      'Yêu cầu hồ sơ học vấn và chứng minh tài chính; điều kiện cụ thể tùy trường và thời điểm.',
    tags: ['du học', 'student', 'visa', 'làm thêm', 'nhật bản'],
    market: 'japan',
  },

  // ---- Industries ---------------------------------------------------------
  {
    category: 'industry',
    title: 'Ngành Điều dưỡng - Hộ lý (Kaigo)',
    content:
      'Điều dưỡng/hộ lý (chăm sóc người cao tuổi) là ngành nhu cầu rất lớn ở Nhật và Đức. Công việc gồm hỗ trợ ' +
      'sinh hoạt, chăm sóc sức khỏe người già tại viện dưỡng lão/bệnh viện. Yêu cầu sự cẩn thận, kiên nhẫn và ' +
      'tiếng theo chương trình (Nhật thường N4-N3, Đức thường B1-B2). Là ngành có lộ trình ổn định, dễ gia hạn.',
    tags: ['điều dưỡng', 'hộ lý', 'kaigo', 'chăm sóc', 'nursing', 'care'],
  },
  {
    category: 'industry',
    title: 'Ngành Xây dựng',
    content:
      'Nhóm ngành xây dựng gồm nhiều nghề: giàn giáo, cốt pha, mộc, sơn, lắp đặt đường ống, cốt thép... Phù hợp ' +
      'lao động nam có sức khỏe tốt, chịu được công việc ngoài trời. Đây là nhóm ngành tuyển số lượng lớn và đều đặn ' +
      'ở Nhật. Mức lương và yêu cầu tiếng tùy đơn hàng và nghề cụ thể.',
    tags: ['xây dựng', 'giàn giáo', 'cốt pha', 'mộc', 'sơn', 'đường ống', 'construction'],
  },
  {
    category: 'industry',
    title: 'Ngành Chế biến thực phẩm',
    content:
      'Chế biến thực phẩm (cơm hộp, thủy sản, thịt, bánh kẹo...) là ngành tuyển nhiều cả nam và nữ, môi trường ' +
      'làm việc trong nhà máy, yêu cầu vệ sinh an toàn thực phẩm. Công việc lặp lại theo dây chuyền, phù hợp lao ' +
      'động chăm chỉ. Yêu cầu tiếng thường ở mức cơ bản; chi tiết tùy đơn hàng.',
    tags: ['chế biến thực phẩm', 'thực phẩm', 'nhà máy', 'food processing', 'cơm hộp'],
  },
  {
    category: 'industry',
    title: 'Ngành Dịch vụ ăn uống - Nhà hàng',
    content:
      'Ngành dịch vụ ăn uống/nhà hàng gồm chế biến món ăn, phục vụ, vận hành bếp. Thuộc nhóm ngành của diện Kỹ năng ' +
      'đặc định tại Nhật, phù hợp ứng viên giao tiếp tốt. Yêu cầu tiếng Nhật giao tiếp khá hơn các ngành sản xuất; ' +
      'điều kiện cụ thể tùy đơn hàng.',
    tags: ['nhà hàng', 'dịch vụ ăn uống', 'ẩm thực', 'restaurant', 'phục vụ', 'bếp'],
  },
  {
    category: 'industry',
    title: 'Ngành Cơ khí - Gia công kim loại',
    content:
      'Cơ khí/gia công kim loại gồm tiện, phay, hàn, dập, đúc, gia công CNC. Phù hợp lao động có tay nghề hoặc ' +
      'được đào tạo, và là ngành mạnh cho cả diện thực tập sinh lẫn kỹ sư. Mức lương tham khảo khá cạnh tranh; ' +
      'yêu cầu tay nghề và tiếng tùy đơn hàng.',
    tags: ['cơ khí', 'gia công kim loại', 'hàn', 'tiện', 'phay', 'cnc', 'machining'],
  },
  {
    category: 'industry',
    title: 'Ngành Bảo dưỡng - Sửa chữa ô tô',
    content:
      'Bảo dưỡng và sửa chữa ô tô là nhóm ngành của diện Kỹ năng đặc định, gồm kiểm tra, bảo dưỡng định kỳ và sửa ' +
      'chữa xe. Phù hợp ứng viên có nền tảng kỹ thuật ô tô/cơ khí. Yêu cầu thi kỹ năng ngành và tiếng theo quy định; ' +
      'chi tiết tùy đơn hàng.',
    tags: ['ô tô', 'sửa chữa ô tô', 'bảo dưỡng', 'auto', 'kỹ thuật'],
  },
  {
    category: 'industry',
    title: 'Ngành Nông nghiệp',
    content:
      'Nông nghiệp gồm trồng trọt (rau, hoa quả trong nhà kính) và chăn nuôi. Công việc theo mùa vụ, môi trường ' +
      'nông trại, phù hợp lao động cả nam và nữ chịu khó. Tuyển đều ở Nhật, Hàn Quốc và Đài Loan. Yêu cầu tiếng ' +
      'thường cơ bản; điều kiện tùy đơn hàng.',
    tags: ['nông nghiệp', 'trồng trọt', 'chăn nuôi', 'nông trại', 'agriculture'],
  },
  {
    category: 'industry',
    title: 'Ngành May mặc',
    content:
      'May mặc/dệt may gồm may công nghiệp, cắt, là, kiểm phẩm. Là ngành tuyển nhiều lao động nữ, làm việc trong ' +
      'xưởng. Phù hợp ứng viên có kinh nghiệm may hoặc khéo tay. Yêu cầu tiếng cơ bản; mức lương và điều kiện tùy đơn hàng.',
    tags: ['may mặc', 'dệt may', 'may công nghiệp', 'garment', 'nữ'],
  },
  {
    category: 'industry',
    title: 'Ngành Vận tải - Lái xe',
    content:
      'Ngành vận tải/lái xe (giao hàng, lái xe tải) là nhóm ngành mới mở rộng cho diện Kỹ năng đặc định tại Nhật. ' +
      'Yêu cầu bằng lái phù hợp, sức khỏe tốt và tiếng Nhật theo quy định. Đây là ngành tiềm năng; điều kiện cụ thể ' +
      'tùy đơn hàng và quy định hiện hành.',
    tags: ['vận tải', 'lái xe', 'giao hàng', 'driving', 'logistics'],
  },

  // ---- Recruitment process ------------------------------------------------
  {
    category: 'process',
    title: 'Quy trình tham gia XKLĐ tổng quan',
    content:
      'Quy trình tham gia thường gồm các bước: (1) Tư vấn chọn thị trường/ngành/visa; (2) Hoàn thiện hồ sơ và ' +
      'khám sức khỏe; (3) Đào tạo tiếng (Nhật/Đức/Hàn) và kỹ năng; (4) Ghép đơn hàng phù hợp; (5) Phỏng vấn với ' +
      'nghiệp đoàn/công ty tiếp nhận; (6) Xin tư cách lưu trú (COE); (7) Xin visa; (8) Xuất cảnh và hỗ trợ sau khi ' +
      'sang. Thời gian mỗi bước tùy chương trình; liên hệ tư vấn để có lộ trình cụ thể.',
    tags: ['quy trình', 'lộ trình', 'hồ sơ', 'phỏng vấn', 'coe', 'visa', 'xuất cảnh'],
  },
  {
    category: 'process',
    title: 'Bước Tư vấn và đánh giá đầu vào',
    content:
      'Ở bước tư vấn, chuyên viên đánh giá độ tuổi, sức khỏe, học vấn, kinh nghiệm, nguyện vọng thị trường và ngành ' +
      'nghề để định hướng diện visa phù hợp (TTS, Tokutei, Kỹ sư...). Đây là bước quan trọng giúp ứng viên chọn đúng ' +
      'lộ trình, tránh chi phí và thời gian không cần thiết.',
    tags: ['tư vấn', 'đánh giá', 'đầu vào', 'định hướng', 'quy trình'],
  },
  {
    category: 'process',
    title: 'Bước Đào tạo tiếng và ghép đơn',
    content:
      'Sau khi hoàn thiện hồ sơ, ứng viên tham gia đào tạo tiếng và kỹ năng tại trung tâm. Khi đạt trình độ yêu cầu, ' +
      'công ty ghép ứng viên với đơn hàng phù hợp rồi tổ chức phỏng vấn với phía tiếp nhận. Đỗ phỏng vấn sẽ tiến hành ' +
      'thủ tục COE và visa. Thời gian đào tạo tùy trình độ ban đầu và yêu cầu đơn hàng.',
    tags: ['đào tạo', 'tiếng nhật', 'ghép đơn', 'phỏng vấn', 'quy trình'],
  },

  // ---- Branches -----------------------------------------------------------
  {
    category: 'branch',
    title: 'Hệ thống chi nhánh toàn quốc',
    content:
      'Thanh Giang có trụ sở chính tại Hà Nội và hơn 15 chi nhánh trên toàn quốc, gồm TP. Hồ Chí Minh, Nghệ An, ' +
      'Huế, Bắc Ninh, Hải Phòng, Thanh Hóa, Hà Tĩnh, Đà Nẵng, Đồng Nai, Cà Mau, Gia Lai, Đắk Lắk... Người lao động ' +
      'có thể đến chi nhánh gần nhất để được tư vấn trực tiếp. Liên hệ hotline để biết địa chỉ chi nhánh cụ thể.',
    tags: ['chi nhánh', 'văn phòng', 'hà nội', 'hồ chí minh', 'toàn quốc', 'địa chỉ'],
  },

  // ---- FAQs ---------------------------------------------------------------
  {
    category: 'faq',
    title: 'Chi phí tham gia XKLĐ là bao nhiêu?',
    content:
      'Chi phí phụ thuộc thị trường, ngành nghề, diện visa và đơn hàng cụ thể, bao gồm các khoản như đào tạo, hồ sơ, ' +
      'khám sức khỏe và dịch vụ theo quy định. Thanh Giang cam kết minh bạch chi phí theo quy định pháp luật; để biết ' +
      'con số chính xác cho trường hợp của bạn, vui lòng liên hệ tư vấn. (Không có mức phí cố định cho mọi đơn hàng.)',
    tags: ['chi phí', 'phí', 'tiền', 'bao nhiêu', 'faq'],
  },
  {
    category: 'faq',
    title: 'Điều kiện độ tuổi để đi XKLĐ?',
    content:
      'Độ tuổi yêu cầu thay đổi theo thị trường và diện visa: thực tập sinh và kỹ năng đặc định thường nhận lao động ' +
      'trẻ (phổ biến khoảng 18-35 tuổi), diện kỹ sư có thể linh hoạt hơn theo bằng cấp. Một số đơn hàng có giới hạn ' +
      'riêng. Vui lòng liên hệ tư vấn để kiểm tra điều kiện chính xác theo nguyện vọng của bạn.',
    tags: ['độ tuổi', 'điều kiện', 'tuổi', 'faq'],
  },
  {
    category: 'faq',
    title: 'Cần trình độ tiếng Nhật N mấy?',
    content:
      'Trình độ tiếng Nhật yêu cầu tùy diện và ngành: thực tập sinh thường khoảng N5-N4, kỹ năng đặc định thường N4 ' +
      'trở lên (hoặc JFT-Basic) kèm thi kỹ năng, diện kỹ sư thường N3 trở lên. Người chưa biết tiếng vẫn có thể bắt ' +
      'đầu vì công ty có đào tạo từ cơ bản. Yêu cầu cụ thể theo từng đơn hàng.',
    tags: ['tiếng nhật', 'n5', 'n4', 'n3', 'n2', 'n1', 'trình độ', 'faq'],
  },
  {
    category: 'faq',
    title: 'Thời gian từ lúc đăng ký đến khi xuất cảnh?',
    content:
      'Thời gian phụ thuộc trình độ tiếng ban đầu, tốc độ hoàn thiện hồ sơ, lịch ghép đơn và phỏng vấn, cũng như thời ' +
      'gian xử lý COE/visa. Thông thường mất vài tháng đến khoảng một năm tùy chương trình. Đào tạo tiếng tốt từ đầu ' +
      'giúp rút ngắn thời gian. Liên hệ tư vấn để ước lượng theo trường hợp của bạn.',
    tags: ['thời gian', 'bao lâu', 'xuất cảnh', 'tiến độ', 'faq'],
  },
  {
    category: 'faq',
    title: 'Visa có gia hạn được không, có về sớm được không?',
    content:
      'Khả năng gia hạn tùy diện visa: thực tập sinh và kỹ năng đặc định có thể gia hạn theo quy định và lộ trình ' +
      'chuyển diện (ví dụ TTS lên Tokutei); diện kỹ sư có lộ trình dài hạn và định cư. Việc về nước trước hạn liên ' +
      'quan đến hợp đồng và quy định; nên trao đổi kỹ với tư vấn trước khi quyết định.',
    tags: ['gia hạn', 'visa', 'về nước', 'chuyển diện', 'faq'],
  },
  {
    category: 'faq',
    title: 'Không có kinh nghiệm hoặc bằng cấp cao có đi được không?',
    content:
      'Có. Nhiều đơn hàng diện thực tập sinh và kỹ năng đặc định nhận lao động phổ thông chưa có kinh nghiệm, được đào ' +
      'tạo trước khi đi. Diện kỹ sư mới yêu cầu bằng cao đẳng/đại học đúng chuyên ngành. Tùy nền tảng của bạn, tư vấn ' +
      'sẽ định hướng diện phù hợp nhất.',
    tags: ['kinh nghiệm', 'bằng cấp', 'lao động phổ thông', 'điều kiện', 'faq'],
  },
  {
    category: 'faq',
    title: 'Nữ giới có thể tham gia những ngành nào?',
    content:
      'Lao động nữ phù hợp với nhiều ngành như điều dưỡng/hộ lý, chế biến thực phẩm, may mặc, nông nghiệp, dịch vụ ' +
      'nhà hàng và một số nghề cơ khí nhẹ. Một số đơn hàng quy định giới tính cụ thể. Tư vấn sẽ giúp chọn đơn hàng ' +
      'phù hợp với nguyện vọng và điều kiện của ứng viên nữ.',
    tags: ['nữ', 'giới tính', 'ngành nghề', 'điều dưỡng', 'may mặc', 'faq'],
  },
  {
    category: 'faq',
    title: 'Sang nước ngoài có được hỗ trợ gì không?',
    content:
      'Công ty hỗ trợ ứng viên trong suốt quá trình: đào tạo trước khi đi, hướng dẫn thủ tục, và kết nối hỗ trợ khi ' +
      'sang nước tiếp nhận theo chương trình. Mức độ hỗ trợ cụ thể tùy đơn hàng và nghiệp đoàn/công ty tiếp nhận. ' +
      'Vui lòng liên hệ tư vấn để biết chi tiết quyền lợi.',
    tags: ['hỗ trợ', 'sau xuất cảnh', 'nghiệp đoàn', 'quyền lợi', 'faq'],
  },
];

/** Total curated entries (handy for seed logging / tests). */
export const KNOWLEDGE_BASE_COUNT = KNOWLEDGE_BASE.length;
