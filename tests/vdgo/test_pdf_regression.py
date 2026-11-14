"""Fast regression checks for the most visible v5 PDF issues.

Run from project root with:
    python -m unittest discover -s tests/vdgo -p 'test_*.py' -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
import zipfile
from io import BytesIO
from tempfile import TemporaryDirectory
from http.server import HTTPServer
from threading import Thread
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from unittest.mock import patch

import fitz
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "services" / "vdgo" / "backend"
sys.path.insert(0, str(BACKEND))
from app import OUTPUT, TEMPLATE, DEFECTS, Handler, build_pdf, normalize_form_dates, PAGE, append_extra_photo_pages, _ordered_uploaded_photos, compact_specialist_certificate, _download_disposition  # noqa: E402
from pdf_to_docx import pdf_to_docx  # noqa: E402
from pdf_to_docx_editable import pdf_to_docx_editable  # noqa: E402


class DownloadBehaviorRegressionTests(unittest.TestCase):
    def test_attachment_filename_is_safe_and_contains_report_metadata(self):
        disposition = _download_disposition({
            "report_number": 'АБ/12 "опасное"', "report_date": "14.10.2026",
        }, "pdf")
        self.assertTrue(disposition.startswith('attachment; filename="Zaklyuchenie_'))
        self.assertIn("filename*=UTF-8''", disposition)
        self.assertIn("%D0%97%D0%B0%D0%BA%D0%BB%D1%8E%D1%87%D0%B5%D0%BD%D0%B8%D0%B5", disposition)
        self.assertNotIn('\"опасное\"', disposition)

    def test_generated_files_use_native_hidden_iframe_download_path(self):
        self.assertIn('id="vdgoDownloadFrame" name="vdgoDownloadFrame"', PAGE)
        self.assertIn("form.setAttribute('target','vdgoDownloadFrame')", PAGE)
        self.assertIn('HTMLFormElement.prototype.submit.call(form)', PAGE)
        self.assertIn('Unlike fetch()+Blob, it preserves the browser', PAGE)

    def test_generate_endpoint_returns_pdf_as_download_attachment(self):
        with TemporaryDirectory() as temporary:
            path = Path(temporary) / "stub.pdf"
            with fitz.open() as document:
                document.new_page()
                document.save(path)
            server = HTTPServer(("127.0.0.1", 0), Handler)
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                body = urlencode({"report_number": "QA-7", "report_date": "14.10.2026"}).encode()
                request = Request(
                    f"http://127.0.0.1:{server.server_port}/generate",
                    data=body, headers={"Content-Type": "application/x-www-form-urlencoded"},
                    method="POST",
                )
                with patch("app.validate_form"), patch("app.build_pdf", return_value=path), patch("app.record_generation"):
                    with urlopen(request, timeout=10) as response:
                        payload = response.read()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.headers.get("Content-Type"), "application/pdf")
                        disposition = response.headers.get("Content-Disposition", "")
                        self.assertTrue(disposition.startswith("attachment;"))
                        self.assertIn("QA-7", disposition)
                        self.assertIn("filename*=UTF-8''", disposition)
                        self.assertEqual(len(payload), int(response.headers.get("Content-Length", "0")))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=3)


class PdfRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.output = OUTPUT / "generated.pdf"
        cls.form = {
            "report_number": "QA-2026-001",
            "report_date": "14.10.2026",
            "report_year": "2026",
            "min_thickness": "2,7",
            "max_thickness": "3,5",
            "address": "Республика Татарстан, г. Казань, ул. Юлиуса Фучика, д. 105",
            "executor_legal_name": "Общество с ограниченной ответственностью «Профит»",
            "executor": "ООО «Профит»",
            "executor_phone": "+7 900 111-22-33",
            "customer_address": "420000, Республика Татарстан, г. Казань, ул. Тестовая, д. 15",
            "general_director": "В.А. Палагин",
            "customer": "ООО «Демо заказчик»",
            "customer_director": "И.И. Иванов",
            "general_director_full": "Петров Пётр Петрович",
            "specialist": "А.А. Козлов",
            "specialist_full": "Козлов Александр Александрович",
            "specialist_certificate": "Квалификационное удостоверение специалиста II уровня УК, ВИК № 0039-11-28361 от 07.07.2023 г. Независимый орган аттестации персонала в области НК ООО «Лидер НК»",
            "specialist_additional_certificate": "Дополнительная квалификация специалиста: УК, ВИК, неразрушающий контроль по соответствующим методам.",
            "technician": "Э.Ф. Валиуллин",
            "technician_full": "Валиуллин Эдуард Фардинантович",
            "technician_certificate": "удостоверение № 826 от 06.02.2025 г., АНО ДПО УТЦ «Профессионал»",
            "work_group_order_number": "8Б",
            "work_group_order_date": "09.01.2024",
            "next_diagnostic": "марта 2029 года",
            "remaining_life_years": "3 года",
            "resource_working_pressure": "1,25",
            "resource_calculated_by": "И.И. Иванов",
            "test_result": "Проверка герметичности не проводилась по причине отсутствия доступа к отдельным помещениям по акту.",
            "conclusion_text": "Запорная арматура проверена. По результатам осмотра замечаний не выявлено.",
            "defect_1_enabled": "1",
            "defect_1_location": DEFECTS[0]["location"],
            "defect_1_text": DEFECTS[0]["defect"],
            "defect_1_recommendation": DEFECTS[0]["recommendation"],
            "uk_device_model": "А1211Mini",
            "uk_device_serial": "1234567",
            "uk_calibration_date": "14.10.2026",
            "uk_joint_number": "15",
            "uk_material_description": "Сталь Ø42, толщина 3,1 мм",
            "uk_sensitivity": "1,0",
            "uk_defect_description": "Дефектов не обнаружено",
            "uk_result": "Годен",
            "uk_accessibility_percent": "100",
            "gas_status": "not_detected",
            "leak_status": "not_detected",
            # Small source-table values verify that empty/sparse cells still use readable typography.
            "uzt_shared_1_segment": "Участок 1",
            "uzt_shared_1_diameter": "32",
            "uzt_shared_1_thickness": "3,2",
            "uzt_flat_1_apartment": "1",
            "uzt_flat_1_du25": "3,2",
            "uzt_flat_1_du20": "2,8",
            "uzt_flat_1_du15": "2,4",
            "resource_section_1": "№ 1",
            "resource_kz_1": "1,1",
            "resource_thickness_1": "3,2",
            "resource_base_velocity_1": "0,01",
            "resource_k1_1": "1,0",
            "resource_k2_1": "1,0",
            "resource_factor_1": "1,0",
            "resource_velocity_1": "0,01",
            "resource_years_1": "3",
        }
        # Keep a full, long-text defect list in the regression fixture so Appendix 12
        # tests cover both pages of the table, not only its first row.
        for i, defect in enumerate(DEFECTS, 1):
            if i == 1:
                continue  # Preserve the custom first-row values asserted by the tests below.
            cls.form[f"defect_{i}_enabled"] = "1"
            cls.form[f"defect_{i}_location"] = defect["location"]
            cls.form[f"defect_{i}_text"] = defect["defect"]
            cls.form[f"defect_{i}_recommendation"] = defect["recommendation"]
        # Keep the legacy 49-page fixture complete for all per-page regression checks.
        # Nineteen photos deliberately leave slot 20 empty on a retained page; both
        # App. 2 sheets are supplied explicitly as test images (never inherited from the template).
        cls.upload_image = OUTPUT / "_regression_upload.png"
        Image.new("RGB", (240, 240), (245, 245, 245)).save(cls.upload_image)
        cls.uploads = {f"photo_{i}": str(cls.upload_image) for i in range(1, 20)}
        cls.uploads["material_page_16"] = str(cls.upload_image)
        cls.uploads["material_page_17"] = str(cls.upload_image)
        build_pdf(cls.form, cls.uploads)

    @classmethod
    def tearDownClass(cls):
        cls.output.unlink(missing_ok=True)
        cls.upload_image.unlink(missing_ok=True)
        work = OUTPUT / "_work.pdf"
        work.unlink(missing_ok=True)

    def test_document_has_49_pages(self):
        with fitz.open(self.output) as doc:
            self.assertEqual(len(doc), 49)

    def test_cover_replacement_text_is_searchable(self):
        with fitz.open(self.output) as doc:
            text = doc[0].get_text()
            self.assertIn("QA-2026-001", text)
            self.assertIn("Республика Татарстан", text)
            self.assertIn("Юлиуса Фучика", text)
            self.assertNotIn("\ufffd", text)


    def test_appendix12_defect_text_stays_inside_its_source_column(self):
        # Page 39 splits at x≈347.5; page 40 at x≈304.9. Each defect/location
        # span must stay on the left side of the recommendation column.
        with fitz.open(self.output) as doc:
            checks = (
                (38, 112.0, 347.5, (220.0, 740.0), ("смотри схему", "Нарушение технологии", "Техническое обслуживание")),
                (39, 69.0, 304.9, (80.0, 610.0), ("смотри схему", "Касание газопровода", "Провода и кабели")),
            )
            for page_index, x_min, split_x, y_band, needles in checks:
                page = doc[page_index]
                spans = [span for block in page.get_text("dict", sort=True)["blocks"] if block.get("type") == 0
                         for line in block.get("lines", []) for span in line.get("spans", [])
                         if str(span.get("text") or "").strip()
                         and y_band[0] <= span["bbox"][1] <= y_band[1]
                         and x_min <= span["bbox"][0] < split_x]
                candidates = [span for span in spans if any(needle.casefold() in span["text"].casefold() for needle in needles)]
                self.assertTrue(candidates, f"No inserted Appendix 12 location text found on PDF page {page_index + 1}")
                for span in candidates:
                    self.assertLessEqual(span["bbox"][2], split_x + 1.2,
                                         f"Text crossed into the recommendation column on page {page_index + 1}: {span['text']!r}")

    def test_section_5_4_conclusion_is_below_valve_table(self):
        with fitz.open(self.output) as doc:
            spans = [span for block in doc[8].get_text("dict")["blocks"] if block.get("type") == 0
                     for line in block.get("lines", []) for span in line.get("spans", [])]
            conclusion = next(span for span in spans if "Вывод: Запорная арматура проверена" in span["text"])
            self.assertGreaterEqual(conclusion["bbox"][1], 357.0)
            self.assertLessEqual(conclusion["bbox"][3], 389.5)

    def test_generic_replacements_inherit_original_body_font_size(self):
        with fitz.open(self.output) as doc:
            page = doc[4]
            phone = next(span for block in page.get_text("dict")["blocks"] if "lines" in block
                         for line in block["lines"] for span in line["spans"]
                         if "+7 900 111-22-33" in span["text"])
            self.assertGreaterEqual(phone["size"], 10.5)
            self.assertLessEqual(phone["size"], 12.1)
            self.assertNotIn("+7 843 202-30-29", page.get_text())

    def test_appendix_5_instrument_metadata_is_not_tiny(self):
        with fitz.open(self.output) as doc:
            spans = [span for block in doc[29].get_text("dict")["blocks"] if "lines" in block
                     for line in block["lines"] for span in line["spans"]]
            model = next(span for span in spans if "А1211Mini" in span["text"])
            serial = next(span for span in spans if "1234567" in span["text"])
            self.assertGreaterEqual(model["size"], 9.3)
            self.assertGreaterEqual(serial["size"], 9.3)

    def test_appendix_2_diagrams_are_preserved(self):
        with fitz.open(self.output) as doc:
            for index, entrance in ((15, "подъезд 1"), (16, "подъезд 2")):
                text = doc[index].get_text()
                self.assertIn("неразрушающего контроля", text)
                self.assertIn("Юлиуса Фучика", text)
                self.assertIn(entrance, text)
                self.assertGreaterEqual(len(doc[index].get_images(full=True)), 1)

    def test_specialist_credential_is_written_once_without_overlapping_lines(self):
        with fitz.open(self.output) as doc:
            page = doc[4]
            normalized = ' '.join(page.get_text().split())
            phrase = 'Независимый орган аттестации персонала в области НК ООО'
            self.assertEqual(normalized.count(phrase), 1, 'Specialist credential phrase must not be duplicated by the generic replacer')
            lines = []
            for block in page.get_text('dict')['blocks']:
                if block.get('type') != 0:
                    continue
                for line in block.get('lines', []):
                    spans = [span for span in line.get('spans', [])
                             if 405 <= span['bbox'][1] < 534 and span['bbox'][0] >= 170 and span['text'].strip()]
                    if spans:
                        lines.append((min(span['origin'][1] for span in spans), ' '.join(span['text'] for span in spans)))
            lines.sort()
            for (first_y, first_text), (second_y, second_text) in zip(lines, lines[1:]):
                self.assertGreaterEqual(second_y-first_y, 8.5,
                    f'Credential text baselines are too close: {first_text!r} / {second_text!r}')

    def test_contents_protocol_rows_stay_inside_the_title_column(self):
        with fitz.open(self.output) as doc:
            page = doc[2]
            rows = [span for block in page.get_text('dict')['blocks'] if block.get('type') == 0
                    for line in block.get('lines', []) for span in line.get('spans', [])
                    if any(label in span['text'] for label in ('Приложение 4 Протокол', 'Приложение 5 Протокол', 'Приложение 6 Протокол'))]
            self.assertEqual(len(rows), 3)
            for span in rows:
                self.assertLessEqual(span['bbox'][2], 523.5,
                    f'Contents caption entered the page-number column: {span["text"]!r} {span["bbox"]}')
            text = ' '.join(page.get_text().split())
            self.assertIn('Приложение 4 Протокол № QA-2026-001', text)
            self.assertIn('Приложение 5 Протокол № QA-2026-001', text)
            self.assertIn('Приложение 6 Протокол № QA-2026-001', text)

    def test_printed_page_30_uses_compact_certificate_not_long_overflow_text(self):
        changed_certificate = (
            'Квалификационное удостоверение специалиста II уровня УК, ВИК № '
            '777-22-555 от 02.02.2025 г. Независимый орган аттестации персонала '
            'в области НК ООО «Аттестация»'
        )
        self.assertEqual(compact_specialist_certificate(changed_certificate),
                         '№ 777-22-555 (УК, ВИК) от 02.02.2025 г.')
        with fitz.open(self.output) as doc:
            page = doc[29]
            text = ' '.join(page.get_text().split())
            self.assertNotIn('Независимый орган аттестации персонала', text)
            self.assertIn('№ 0039-11-28361 (УК, ВИК) от 07.07.2023 г.', text)
            cert_spans = [span for block in page.get_text('dict')['blocks'] if block.get('type') == 0
                          for line in block.get('lines', []) for span in line.get('spans', [])
                          if '№ 0039-11-28361' in span['text']]
            self.assertTrue(cert_spans)
            self.assertTrue(all(span['bbox'][2] < 400 for span in cert_spans),
                            f'Compact certification line extends beyond its allotted area: {[s["bbox"] for s in cert_spans]}')

    def test_no_uploaded_schemes_or_photos_removes_sample_diagrams_and_empty_photo_sheets(self):
        import shutil
        backup = OUTPUT / '_generated_full_fixture_backup.pdf'
        shutil.copy2(self.output, backup)
        try:
            build_pdf(self.form, {})
            with fitz.open(self.output) as doc:
                self.assertEqual(len(doc), 37, 'Without App. 2 uploads and photos, 12 optional pages should be omitted')
                text = '\n'.join(page.get_text() for page in doc)
                self.assertNotIn('Схема неразрушающего контроля', text)
                self.assertNotIn('Фото дефектного участка', text)
                self.assertNotIn('Фото 1', text)
                self.assertNotIn('Фото 2', text)
                # The footer sequence is renumbered after optional pages are removed.
                for page_index, page in enumerate(doc[1:], start=2):
                    footers = [span['text'].strip() for block in page.get_text('dict')['blocks'] if block.get('type') == 0
                               for line in block.get('lines', []) for span in line.get('spans', [])
                               if 785 <= span['bbox'][1] < 815 and span['text'].strip().isdigit()]
                    self.assertIn(str(page_index), footers, f'Wrong page number on output page {page_index}: {footers}')
        finally:
            shutil.copy2(backup, self.output)
            backup.unlink(missing_ok=True)

    def test_partial_photo_appendix_keeps_only_uploaded_photo_labels(self):
        import shutil
        backup = OUTPUT / '_generated_full_fixture_backup.pdf'
        shutil.copy2(self.output, backup)
        try:
            one_photo = {'photo_1': str(self.upload_image)}
            build_pdf(self.form, one_photo)
            with fitz.open(self.output) as doc:
                self.assertEqual(len(doc), 38, 'One photo sheet plus omitted App. 2 and remaining nine photo sheets should yield 38 pages')
                photo_pages = [page for page in doc if 'Фото 1' in page.get_text() and 'Приложение 3' in page.get_text()]
                self.assertEqual(len(photo_pages), 1)
                text = photo_pages[0].get_text()
                self.assertIn('Фото 1', text)
                self.assertNotIn('Фото 2', text)
        finally:
            shutil.copy2(backup, self.output)
            backup.unlink(missing_ok=True)

    def test_chapter_6_first_defect_is_below_merged_parent_row(self):
        with fitz.open(self.output) as doc:
            spans = [span for block in doc[9].get_text('dict')['blocks'] if block.get('type') == 0
                     for line in block.get('lines', []) for span in line.get('spans', [])
                     if 'Подъезд №1, условный проход Ду32' in span['text']]
            self.assertTrue(spans)
            for span in spans:
                self.assertGreaterEqual(span['bbox'][1], 140.0, f'First defect location overlaps the merged row: {span["bbox"]}')
                self.assertLessEqual(span['bbox'][2], 304.8, f'First defect location crossed the table column: {span["bbox"]}')

    def test_cover_text_is_native_pdf_text_not_an_image(self):
        with fitz.open(self.output) as doc:
            cover = doc[0]
            spans = [span for block in cover.get_text("dict")["blocks"] if "lines" in block
                     for line in block["lines"] for span in line["spans"]]
            title = next(span for span in spans if "Заключение № QA-2026-001" in span["text"])
            self.assertAlmostEqual(title["size"], 20.04, delta=0.2)
            self.assertIn("Carlito Bold", [font[3] for font in cover.get_fonts(full=True)])
            # The generated title must be a native, selectable text object, not a page PNG.
            self.assertEqual(len(cover.get_images(full=True)), 0)
            self.assertTrue(cover.search_for("QA-2026-001"))

    def test_resource_summary_keeps_original_12pt_size(self):
        with fitz.open(self.output) as doc:
            spans = [span for block in doc[8].get_text("dict")["blocks"] if "lines" in block
                     for line in block["lines"] for span in line["spans"]]
            value = next(span for span in spans if "составляет 3 года" in span["text"])
            self.assertAlmostEqual(value["size"], 12.0, delta=0.2)

    def test_russian_date_picker_values_are_normalized_for_the_pdf(self):
        form = {
            "report_date": "2026-10-14",
            "work_group_order_date": "2026-10-09",
            "uzt_calibration_date": "2025-04-03",
            "uk_calibration_date_nd": "1",
            "next_diagnostic": "2028-03-14",
        }
        normalize_form_dates(form)
        self.assertEqual(form["report_date"], "14.10.2026")
        self.assertEqual(form["work_group_order_date"], "09.10.2026")
        self.assertEqual(form["uzt_calibration_date"], "03.04.2025")
        self.assertEqual(form["uk_calibration_date"], "н.д.")
        self.assertEqual(form["next_diagnostic"], "14 марта 2028 года")

    def test_dynamic_photo_button_can_add_a_row_and_upload_cap_matches_ui(self):
        self.assertIn('onclick="addPhotoRow(true)"', PAGE)
        self.assertIn('function addPhotoRow(force=false)', PAGE)
        self.assertIn('function ensureEmptyPhotoRow()', PAGE)
        self.assertIn('512 МБ', PAGE)
        source=(BACKEND / 'app.py').read_text(encoding='utf-8')
        self.assertIn('if n>512*1024*1024:', source)
        nginx=(ROOT / 'infra' / 'nginx' / 'nginx-unified.conf').read_text(encoding='utf-8')
        self.assertIn('client_max_body_size 512m;', nginx)

    def test_dates_accept_keyboard_digits_and_format_as_russian(self):
        self.assertIn('function maskRussianDate(input)', PAGE)
        self.assertIn('inputmode="numeric"', PAGE)
        self.assertIn('placeholder="ДД.ММ.ГГГГ"', PAGE)
        self.assertIn('function openDatePicker(name)', PAGE)
        self.assertIn('name="report_date"', PAGE)
        self.assertIn('name="next_diagnostic"', PAGE)
        self.assertIn('name="work_group_order_date"', PAGE)

    def test_all_russian_date_fields_use_keyboard_mask_and_calendar_validation(self):
        fields = ('report_date', 'work_group_order_date', 'next_diagnostic', 'uzt_calibration_date', 'uk_calibration_date')
        for field in fields:
            self.assertIn(f'id="{field}"', PAGE)
            self.assertIn(f"openDatePicker('{field}')", PAGE)
            self.assertIn('maskRussianDate(this)', PAGE)
        self.assertIn('function isValidRussianDate(value)', PAGE)
        self.assertIn('function dateDigitsToText(raw)', PAGE)
        self.assertNotIn('oninput="maskRussianDate(this)" oninput=', PAGE)

    def test_test_result_uses_readable_body_font_size(self):
        with fitz.open(self.output) as doc:
            spans = [span for block in doc[8].get_text('dict')['blocks'] if 'lines' in block
                     for line in block['lines'] for span in line['spans']]
            result = next(span for span in spans if 'Проверка герметичности не проводилась' in span['text'])
            self.assertGreaterEqual(result['size'], 9.0)

    def test_unused_photo_slot_is_white_and_its_label_is_removed(self):
        with fitz.open(self.output) as doc:
            page = doc[26]  # Original App. 3 sheet with photo 19; slot/photo 20 is unused.
            self.assertNotIn('Фото 20', page.get_text())
            pix = page.get_pixmap(matrix=fitz.Matrix(1, 1), alpha=False)
            image = Image.open(BytesIO(pix.tobytes('png'))).convert('RGB')
            pixel = image.getpixel((320, 600))
            self.assertGreaterEqual(min(pixel), 245, f'Unused photo slot should be white, got {pixel}')

    def test_word_export_contains_editable_text_and_separate_images(self):
        word_path = OUTPUT / '_editable_word_regression.docx'
        try:
            count = pdf_to_docx(self.output, word_path, dpi=96)
            self.assertEqual(count, 49)
            with zipfile.ZipFile(word_path) as zf:
                xml = zf.read('word/document.xml').decode('utf-8')
                media = [name for name in zf.namelist() if name.startswith('word/media/')]
            # Editable text boxes are native Word content; not a single page-sized screenshot per page.
            self.assertGreater(xml.count('w:txbxContent'), 500)
            self.assertIn('QA-2026-001', xml)
            self.assertIn('Юлиуса Фучика', xml)
            self.assertIn('Место установки', xml)
            self.assertGreater(len(media), 0)
        finally:
            word_path.unlink(missing_ok=True)

    def test_inserted_conclusion_keeps_body_font_size(self):
        with fitz.open(self.output) as doc:
            spans = [sp for block in doc[8].get_text('dict')['blocks'] if 'lines' in block
                     for line in block['lines'] for sp in line['spans']]
            conclusion = next(sp for sp in spans if 'Вывод: Запорная арматура проверена' in sp['text'])
            self.assertGreaterEqual(conclusion['size'], 10.4)
            self.assertLessEqual(conclusion['size'], 12.1)

    def test_defect_values_keep_readable_source_size(self):
        with fitz.open(self.output) as doc:
            spans = [sp for block in doc[9].get_text('dict')['blocks'] if 'lines' in block
                     for line in block['lines'] for sp in line['spans']]
            location = next(sp for sp in spans if 'Подъезд №1, условный проход Ду32' in sp['text'])
            self.assertGreaterEqual(location['size'], 8.0)


    def test_uzt_apartment_values_match_table_typography(self):
        with fitz.open(self.output) as doc:
            page = doc[28]
            spans = [span for block in page.get_text("dict")["blocks"] if "lines" in block
                     for line in block["lines"] for span in line["spans"]]
            for value in ("3,2", "2,8", "2,4"):
                candidates = [span for span in spans if span["text"].strip() == value
                              and 115 <= span["bbox"][1] <= 430]
                self.assertTrue(candidates, f"Expected apartment UZT value {value} was not inserted")
                self.assertTrue(all(span["size"] >= 9.0 for span in candidates),
                                f"Apartment UZT value {value} has too small a font: {[s['size'] for s in candidates]}")

    def test_uzt_shared_values_match_table_typography(self):
        with fitz.open(self.output) as doc:
            page = doc[27]
            spans = [span for block in page.get_text("dict")["blocks"] if "lines" in block
                     for line in block["lines"] for span in line["spans"]]
            for value in ("Участок 1", "32", "3,2"):
                candidates = [span for span in spans if span["text"].strip() == value
                              and 390 <= span["bbox"][1] <= 430]
                self.assertTrue(candidates, f"Expected common UZT value {value} was not inserted")
                self.assertTrue(all(span["size"] >= 9.0 for span in candidates),
                                f"Common UZT value {value} has too small a font: {[s['size'] for s in candidates]}")

    def test_min_max_wall_thickness_values_are_written_to_page_7_as_12pt_text(self):
        with fitz.open(self.output) as doc:
            page = doc[6]
            spans = [sp for block in page.get_text("dict")["blocks"] if "lines" in block
                     for line in block["lines"] for sp in line["spans"]]
            min_value = next(sp for sp in spans if sp["text"].strip() == "2,7" and 605 < sp["bbox"][1] < 625)
            max_value = next(sp for sp in spans if sp["text"].strip() == "3,5" and 620 < sp["bbox"][1] < 640)
            self.assertAlmostEqual(min_value["size"], 12.0, delta=0.2)
            self.assertAlmostEqual(max_value["size"], 12.0, delta=0.2)
            self.assertNotIn("2,4", [sp["text"].strip() for sp in spans if 605 < sp["bbox"][1] < 625])

    def test_section_6_1_grid_lines_restore_original_merged_parent_row(self):
        with fitz.open(self.output) as doc:
            page = doc[9]
            lines=[]
            for drawing in page.get_drawings():
                for item in drawing.get("items", []):
                    if item[0] == "l":
                        a,b=item[1],item[2]
                        if abs(a.y-b.y)<0.05:
                            lines.append((round(a.x,2),round(a.y,2),round(b.x,2),round(b.y,2)))
            # The divider after the parent label is broken across the merged location cell.
            self.assertTrue(any(abs(y-135.98)<0.5 and x0<36 and 85<x1<88 for x0,y,x1,_ in lines),
                            "Left segment of the parent row separator is missing")
            self.assertTrue(any(abs(y-135.98)<0.5 and 304<x0<306 and x1>517 for x0,y,x1,_ in lines),
                            "Right segment of the parent row separator is missing")
            self.assertFalse(any(abs(y-135.98)<0.5 and x0<87 and x1>304 for x0,y,x1,_ in lines),
                             "The parent separator must not cross the merged location cell")
            self.assertTrue(any(abs(y-183.86)<0.5 and x0<36 and x1>517 for x0,y,x1,_ in lines),
                            "The full horizontal separator after row 1.1 must remain visible")

    def test_photo_list_is_dynamic_and_extra_images_get_appendix_pages(self):
        self.assertIn('function addPhotoRow(force=false)', PAGE)
        self.assertIn('function photoSelected(i,input)', PAGE)
        self.assertIn('id="photo-grid"', PAGE)
        from PIL import Image as PILImage
        test_image=OUTPUT/'_extra_photo_test.png'
        try:
            PILImage.new('RGB',(220,220),(120,140,160)).save(test_image)
            ordered=_ordered_uploaded_photos({'photo_23': str(test_image), 'photo_2': str(test_image), 'material_page_31':str(test_image)})
            self.assertEqual(ordered, [str(test_image), str(test_image)])
            with fitz.open(TEMPLATE) as doc:
                temps=append_extra_photo_pages(doc,[str(test_image)], {'report_number':'QA-2026','address':'Тестовый адрес'})
                try:
                    self.assertEqual(len(doc),50)
                    self.assertEqual(len(doc[-1].get_images(full=True)),1)
                    self.assertIn('Приложение 3. Фото дефектного участка (продолжение', doc[-1].get_text())
                finally:
                    for tmp in temps: Path(tmp).unlink(missing_ok=True)
        finally:
            test_image.unlink(missing_ok=True)

    def test_resource_cells_use_readable_font_fallback(self):
        with fitz.open(self.output) as doc:
            page = doc[37]
            spans = [span for block in page.get_text("dict")["blocks"] if "lines" in block
                     for line in block["lines"] for span in line["spans"]]
            for value in ("№ 1", "1,1", "3,2", "0,01"):
                candidates = [span for span in spans if span["text"].strip() == value]
                self.assertTrue(candidates, f"Expected Appendix 11 value {value} was not inserted")
                self.assertTrue(all(span["size"] >= 8.8 for span in candidates),
                                f"Appendix 11 value {value} has too small a font: {[s['size'] for s in candidates]}")

    def test_native_editable_word_uses_real_paragraphs_tables_and_separate_images(self):
        word_path = OUTPUT / '_native_word_regression.docx'
        try:
            count = pdf_to_docx_editable(self.output, word_path)
            self.assertEqual(count, 49)
            from docx import Document
            word = Document(word_path)
            self.assertGreater(len(word.paragraphs), 300)
            self.assertGreater(len(word.tables), 10)
            self.assertIn('QA-2026-001', '\n'.join(p.text for p in word.paragraphs))
            word_text = '\n'.join(p.text for p in word.paragraphs) + '\n' + '\n'.join(cell.text for table in word.tables for row in table.rows for cell in row.cells)
            self.assertIn('2,7', word_text, 'Minimum wall thickness from the form must be editable text in DOCX')
            self.assertIn('3,5', word_text, 'Maximum wall thickness from the form must be editable text in DOCX')
            self.assertGreater(len(word.inline_shapes), 0)
            self.assertLess(len(word.inline_shapes), 49)
            # Appendix 12 metadata must be a normal two-column label/value table.
            metadata = next((table for table in word.tables
                             if len(table.rows) == 3 and len(table.columns) == 2
                             and table.cell(0, 0).text.strip() == 'Заказчик'), None)
            self.assertIsNotNone(metadata, 'Appendix 12 metadata should be a two-column Word table')
            self.assertIn('ООО', metadata.cell(0, 1).text)
            self.assertTrue(any('Согласованные мероприятия' in p.text and 'выявленных при проведении' in p.text
                                for p in word.paragraphs),
                            'Appendix 12 heading should remain a single, natural paragraph')
            heading_index = next(i for i, p in enumerate(word.paragraphs)
                                 if 'Согласованные мероприятия' in p.text)
            self.assertNotEqual(word.paragraphs[heading_index + 1].text.strip().casefold(), 'при',
                                'The word "при" must not be stranded after the Appendix 12 heading')
            appendix_grids = [table for table in word.tables
                              if len(table.columns) == 3
                              and any('Выявленная неисправность' in cell.text for row in table.rows for cell in row.cells)]
            self.assertTrue(appendix_grids, 'Appendix 12 defect grid should be a three-column Word table')
            widths = [cell.width.pt for cell in appendix_grids[0].rows[0].cells if cell.width]
            self.assertEqual(len(widths), 3)
            self.assertLess(widths[0], widths[1])
            self.assertLess(widths[2], widths[1] + 1.0)
            self.assertAlmostEqual(sum(widths), 510.0, delta=2.0)
            # Both signature areas are native 4x2 tables; signature labels are present
            # in paired rows instead of flowing over the credential text.
            signoff_tables = [table for table in word.tables
                              if len(table.rows) == 4 and len(table.columns) == 2
                              and 'Подпись' in '\n'.join(cell.text for row in table.rows for cell in row.cells)
                              and 'Ф.И.О.' in '\n'.join(cell.text for row in table.rows for cell in row.cells)]
            self.assertGreaterEqual(len(signoff_tables), 2)
        finally:
            word_path.unlink(missing_ok=True)


def self_form_fixture():
    return {
        "report_number": "FIELD-7", "report_date": "11.11.2026", "report_year": "2026",
        "address": "г. Тестовый, ул. Тестовая, д. 15", "executor": "ООО Профит",
        "executor_legal_name": "Общество с ограниченной ответственностью Профит",
        "customer": "ООО Заказчик", "customer_legal_name": "ООО Заказчик",
        "customer_address": "г. Тестовый", "customer_phone": "+7 900 000-00-00",
        "customer_director": "И.И. Иванов", "executor_address": "г. Тестовый",
        "executor_phone": "+7 900 000-00-01", "general_director": "П.П. Петров",
        "general_director_full": "Петров Пётр Петрович", "specialist": "И.И. Иванов",
        "specialist_full": "Иванов Иван Иванович", "technician": "П.П. Петров",
        "technician_full": "Петров Пётр Петрович", "technician_certificate": "Удостоверение",
        "specialist_certificate": "Удостоверение", "specialist_additional_certificate": "Не относится",
        "work_group_order_number": "1", "work_group_order_date": "11.11.2026",
        "pipe_length": "10", "pressure": "0.003", "min_thickness": "2.0", "max_thickness": "3.0",
        "next_diagnostic": "ноября 2029 года", "remaining_life_years": "3 года",
        "test_result": "Проверка проведена.", "test_pressure": "500 мм вод.ст.",
        "conclusion_text": "Проверка выполнена.", "resource_working_pressure": "1",
        "resource_calculated_by": "Иванов Иван Иванович", "gas_status": "not_detected",
        "leak_status": "not_detected", "measurement_year": "2026",
        "uk_device_model": "А1211", "uk_device_serial": "123", "uk_calibration_date": "11.11.2026",
        "uk_joint_number": "1", "uk_material_description": "Сталь", "uk_sensitivity": "1",
        "uk_defect_description": "Нет", "uk_result": "Годен", "uk_accessibility_percent": "100",
    }


class WorkforceSchemeSection7Tests(unittest.TestCase):
    def test_selected_workforce_scheme_is_embedded_in_pdf_and_editable_word(self):
        from unittest.mock import patch
        from docx import Document
        with TemporaryDirectory() as temporary:
            temp = Path(temporary)
            scheme_path = temp / "field-scheme.png"
            image = Image.new("RGB", (900, 620), "white")
            # Draw a visible, unique schematic mark to ensure it is embedded as an image.
            from PIL import ImageDraw
            draw = ImageDraw.Draw(image)
            draw.line((60, 80, 840, 80), fill="black", width=5)
            draw.line((450, 80, 450, 540), fill="black", width=5)
            draw.rectangle((220, 220, 680, 420), outline="black", width=4)
            image.save(scheme_path, format="PNG")
            scheme = {
                "path": str(scheme_path),
                "street": "улица Тестовая",
                "address": "15",
                "userName": "Иванов Иван Иванович",
                "submittedAt": "11.11.2026 10:20",
                "reportId": "test-report-7",
                "status": "accepted",
            }
            with patch("app.OUTPUT", temp):
                pdf_path = build_pdf(self_form_fixture(), {}, workforce_schemes=[scheme])
                with fitz.open(pdf_path) as pdf:
                    matches = [i for i, page in enumerate(pdf)
                               if "7. Актуальные схемы, удостоверения и акты" in page.get_text()]
                    self.assertEqual(len(matches), 1)
                    page = pdf[matches[0]]
                    text = page.get_text()
                    self.assertIn("улица Тестовая, дом 15", text)
                    self.assertIn("Иванов Иван Иванович", text)
                    self.assertIn("принята приёмщиком", text)
                    self.assertEqual(len(page.get_images(full=True)), 1)
                    self.assertLess(matches[0], next(i for i, p in enumerate(pdf) if "Приложение 6" in p.get_text()))
                # Export just the inserted PDF page through the same DOCX converter.
                # The main suite already exercises complete-document Word conversion;
                # this focused page-level check proves the new image survives conversion
                # without repeating a costly 40+ page conversion in the regression run.
                section_pdf = temp / "section-7-only.pdf"
                with fitz.open(pdf_path) as full_pdf:
                    section_doc = fitz.open()
                    section_doc.insert_pdf(full_pdf, from_page=matches[0], to_page=matches[0])
                    section_doc.save(section_pdf)
                    section_doc.close()
                docx_path = temp / "report-with-field-scheme.docx"
                page_count = pdf_to_docx_editable(section_pdf, docx_path)
                word = Document(docx_path)
                word_text = "\n".join(p.text for p in word.paragraphs)
                self.assertIn("7. Актуальные схемы, удостоверения и акты", word_text)
                self.assertIn("улица Тестовая, дом 15", word_text)
                self.assertIn("Иванов Иван Иванович", word_text)
                self.assertGreaterEqual(len(word.inline_shapes), 1)
                self.assertEqual(page_count, 1)

    def test_workforce_payload_is_validated_and_written_as_png(self):
        import base64
        import json
        from app import prepare_workforce_schemes
        with TemporaryDirectory() as temporary:
            from unittest.mock import patch
            with patch("app.UPLOADS", Path(temporary)):
                image_path = Path(temporary) / "source.png"
                Image.new("RGB", (300, 300), "white").save(image_path)
                encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
                form = {"workforce_schemes_json": json.dumps([{
                    "id": "report-123", "street": "Тестовая", "address": "15",
                    "userName": "Иванов Иван", "submittedAt": "11.11.2026", "status": "accepted",
                    "pngBase64": encoded,
                }])}
                files = {}
                prepared = prepare_workforce_schemes(form, files)
                self.assertEqual(len(prepared), 1)
                self.assertEqual(prepared[0]["street"], "Тестовая")
                self.assertIn("workforce_scheme_1", files)
                with Image.open(files["workforce_scheme_1"]) as stored:
                    self.assertEqual(stored.format, "PNG")
                Path(files["workforce_scheme_1"]).unlink(missing_ok=True)

    def test_address_folder_materials_bridge_into_section_7_and_appendix_3(self):
        js = (ROOT / "tests" / "fixtures" / "legacy-frontend" / "public" / "conclusion-workforce.js").read_text(encoding="utf-8")
        # The current workflow transfers one reviewed address folder, not individual
        # schemes from a legacy selection list. Schemes are serialized for section 7,
        # while defect photo uploads are mapped to the template's native photo fields
        # that render in Appendix 3.
        self.assertIn("conclusionContext.reports", js)
        self.assertIn("conclusionContext.defectReports", js)
        self.assertIn("workforce_schemes_json", js)
        self.assertIn("data-workforce-photo", js)
        self.assertIn("conclusionContext.task", js)

    def test_long_workforce_json_is_not_treated_as_free_text(self):
        from app import form_field_length_issues, validate_form
        # A modest PNG/base64 payload is already far longer than 500 characters.
        payload = '{"pngBase64":"' + ('A' * 12000) + '"}'
        issues = form_field_length_issues({
            "workforce_schemes_json": payload,
            "conclusion_text": "В" * 701,
        })
        self.assertFalse(any("workforce_schemes_json" in issue for issue in issues))
        self.assertTrue(any("conclusion_text" in issue and "700" in issue for issue in issues))
        # Exercise the actual conclusion validator: it may reject unrelated missing
        # report data, but must not reject this structured attachment field.
        with self.assertRaises(ValueError) as caught:
            validate_form({**self_form_fixture(), "workforce_schemes_json": payload}, {})
        self.assertNotIn("workforce_schemes_json", str(caught.exception))
        self.assertNotIn("слишком длинное (максимум 500 символов)", str(caught.exception))

    def test_workforce_payload_field_name_variants_are_not_free_text(self):
        from app import form_field_length_issues, is_structured_payload_field, normalize_structured_form_field_names
        payload = '{"pngBase64":"' + ('A' * 12000) + '"}'
        for name in (
            "workforce_schemes_json",
            " WORKFORCE_SCHEMES_JSON ",
            "workforce_schemes_json[]",
            "form[workforce_schemes_json]",
        ):
            with self.subTest(name=name):
                self.assertTrue(is_structured_payload_field(name))
                self.assertFalse(any(name in issue for issue in form_field_length_issues({name: payload})))
        self.assertFalse(is_structured_payload_field('workforce_schemes_json_notes'))
        self.assertTrue(any('workforce_schemes_json_notes' in issue for issue in form_field_length_issues({'workforce_schemes_json_notes': payload})))
        aliased = {' WORKFORCE_SCHEMES_JSON[] ': payload}
        normalize_structured_form_field_names(aliased)
        self.assertEqual(aliased, {'workforce_schemes_json': payload})

    def test_workforce_json_still_has_its_own_payload_size_limit(self):
        from unittest.mock import patch
        from app import prepare_workforce_schemes
        with patch("app.MAX_WORKFORCE_SCHEMES_JSON_BYTES", 100):
            with self.assertRaisesRegex(ValueError, "превышает 180 МБ"):
                prepare_workforce_schemes({"workforce_schemes_json": "x" * 101}, {})


class DockerBuildContractTests(unittest.TestCase):
    def test_editable_word_exporter_is_copied_into_backend_image(self):
        dockerfile = (BACKEND / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("pdf_to_docx_editable.py", dockerfile,
                      "The backend imports pdf_to_docx_editable, so Dockerfile must copy it into /app")

    def test_runtime_uses_supported_pymupdf_import(self):
        for rel in ("app.py", "pdf_to_docx.py", "pdf_to_docx_editable.py"):
            source = (BACKEND / rel).read_text(encoding="utf-8")
            self.assertIn("import pymupdf as fitz", source, f"Expected current PyMuPDF import in {rel}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
