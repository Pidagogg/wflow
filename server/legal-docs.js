// ============================================================================
// W FLOW — Legal document content (Impressum · Datenschutzerklärung)
//
// The two documents the legal pages render. AGB and the withdrawal notice were
// removed on purpose: this service publishes an Impressum and a privacy policy
// only. They are written as plain data so the renderer stays generic:
//
//   { nav, title, subtitle?, intro?, blocks?, sections?, notes? }
//
//   sections: [{ h, body: [ paragraph | { list: [items] } ] }]
//   blocks:   [{ label, value }]   — the Impressum's operator table
//
// Text may contain minimal HTML (<strong>, <br/>, <a>) and {{token}}
// placeholders. Placeholder values are resolved by the renderer in
// server/legal.js from the admin settings (legal.*) → LEGAL_* env →
// per-language placeholder.
//
// Two kinds of token:
//   {{token}}   — always printed; without a value a marked placeholder shows
//   {{?token}}  — optional: the *line* disappears when no value is set. Used
//                 for operator details that only apply to some installs
//                 (hosting provider, Cloudflare, third countries, …).
//                 Every section keeps at least one plain paragraph so the
//                 privacy policy always shows all 15 sections.
//
// The privacy policy follows the deployment this software actually is:
//   1. Controller            9. Cookies / local storage
//   2. Hosting / VPS        10. Data deletion
//   3. Cloudflare           11. Storage periods
//   4. PostgreSQL/database  12. Legal bases
//   5. User registration    13. Data-subject rights
//   6. Login/authentication 14. International data transfers
//   6a. Connected accounts (Google & other OAuth services)
//   7. Confirmation e-mails 15. Supervisory authority / right to complain
//   8. IP addresses / server logs
// ============================================================================

export const IMPRESSUM_DOC = {
  de: {
    nav: "Impressum",
    title: "Impressum",
    intro: "Angaben gemäß § 5 DDG (Digitale-Dienste-Gesetz) / § 18 Abs. 2 MStV",
    blocks: [
      { label: "", value: "{{name}}" },
      { label: "", value: "{{?company}}" },
      { label: "", value: "{{?legalForm}}" },
      { label: "", value: "{{address}}" },
      { label: "", value: "{{city}}" },
      { label: "", value: "{{country}}" },
      { label: "Vertreten durch", value: "{{?representative}}" },
      { label: "Kontakt", value: `Telefon: {{?phone}}<br/>E-Mail: {{email}}` },
      {
        label: "{{?registerCourt}}Registereintrag",
        value: `Eintragung im Handelsregister.<br/>Registergericht: {{registerCourt}}<br/>Registernummer: {{?registerNumber}}`,
      },
      {
        label: "{{?vatId}}Umsatzsteuer-ID",
        value: `Umsatzsteuer-Identifikationsnummer gemäß § 27a Umsatzsteuergesetz: {{vatId}}`,
      },
      {
        label: "Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV",
        value: "{{name}}<br/>{{address}}, {{city}}",
      },
    ],
    sections: [
      {
        h: "Haftung für Inhalte",
        body: [
          `Als Diensteanbieter bin ich gemäß § 7 Abs. 1 DDG für eigene Inhalte auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich. Nach §§ 8 bis 10 DDG bin ich als Diensteanbieter jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.`,
          `Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den allgemeinen Gesetzen bleiben hiervon unberührt. Eine diesbezügliche Haftung ist jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung möglich. Bei Bekanntwerden von entsprechenden Rechtsverletzungen werde ich diese Inhalte umgehend entfernen.`,
          `Meldungen rechtswidriger Inhalte richten Sie bitte an: {{?reportEmail}}`,
        ],
      },
      {
        h: "Haftung für Links",
        body: [
          `Mein Angebot enthält ggf. Links zu externen Webseiten Dritter, auf deren Inhalte ich keinen Einfluss habe. Deshalb kann ich für diese fremden Inhalte auch keine Gewähr übernehmen. Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter oder Betreiber der Seiten verantwortlich. Die verlinkten Seiten wurden zum Zeitpunkt der Verlinkung auf mögliche Rechtsverstöße überprüft. Rechtswidrige Inhalte waren zum Zeitpunkt der Verlinkung nicht erkennbar.`,
        ],
      },
      {
        h: "Urheberrecht",
        body: [
          `Die durch den Seitenbetreiber erstellten Inhalte und Werke auf diesen Seiten unterliegen dem deutschen Urheberrecht. Die Vervielfältigung, Bearbeitung, Verbreitung und jede Art der Verwertung außerhalb der Grenzen des Urheberrechtes bedürfen der schriftlichen Zustimmung des jeweiligen Autors bzw. Erstellers.`,
        ],
      },
      {
        h: "Verbraucherstreitbeilegung",
        body: [
          `Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung (OS) bereit: <a href="https://ec.europa.eu/consumers/odr/">https://ec.europa.eu/consumers/odr/</a>.`,
          `Ich bin nicht bereit und nicht verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.`,
        ],
      },
    ],
  },
  en: {
    nav: "Imprint",
    title: "Imprint (Legal Notice)",
    intro: "Information pursuant to § 5 DDG (German Digital Services Act) / § 18 (2) MStV",
    blocks: [
      { label: "", value: "{{name}}" },
      { label: "", value: "{{?company}}" },
      { label: "", value: "{{?legalForm}}" },
      { label: "", value: "{{address}}" },
      { label: "", value: "{{city}}" },
      { label: "", value: "{{country}}" },
      { label: "Represented by", value: "{{?representative}}" },
      { label: "Contact", value: `Phone: {{?phone}}<br/>E-mail: {{email}}` },
      {
        label: "{{?registerCourt}}Commercial register",
        value: `Entry in the commercial register.<br/>Court of registry: {{registerCourt}}<br/>Registration number: {{?registerNumber}}`,
      },
      {
        label: "{{?vatId}}VAT ID",
        value: `VAT identification number pursuant to § 27a of the German VAT Act: {{vatId}}`,
      },
      {
        label: "Responsible for content pursuant to § 18 (2) MStV",
        value: "{{name}}<br/>{{address}}, {{city}}",
      },
    ],
    sections: [
      {
        h: "Liability for content",
        body: [
          `As a service provider I am responsible for my own content on these pages under the general laws, pursuant to § 7 (1) DDG. However, pursuant to §§ 8 to 10 DDG I am not obliged as a service provider to monitor transmitted or stored third-party information or to investigate circumstances that indicate unlawful activity.`,
          `Obligations to remove or block the use of information under the general laws remain unaffected. Liability in this respect is only possible from the time I become aware of a specific infringement of the law. If I become aware of any such infringements, I will remove this content immediately.`,
          `Please report unlawful content to: {{?reportEmail}}`,
        ],
      },
      {
        h: "Liability for links",
        body: [
          `My offering may contain links to external third-party websites over whose content I have no influence. I therefore cannot accept any warranty for this third-party content. The respective provider or operator of the linked pages is always responsible for their content. The linked pages were checked for possible legal violations at the time they were linked. Unlawful content was not recognisable at the time of linking.`,
        ],
      },
      {
        h: "Copyright",
        body: [
          `The content and works created by the site operator on these pages are subject to German copyright law. Reproduction, editing, distribution and any kind of exploitation outside the limits of copyright require the written consent of the respective author or creator.`,
        ],
      },
      {
        h: "Consumer dispute resolution",
        body: [
          `The European Commission provides a platform for online dispute resolution (OS): <a href="https://ec.europa.eu/consumers/odr/">https://ec.europa.eu/consumers/odr/</a>.`,
          `I am neither willing nor obliged to participate in dispute resolution proceedings before a consumer arbitration board.`,
        ],
      },
    ],
  },
  ru: {
    nav: "Импрессум",
    title: "Импрессум (выходные данные)",
    intro: "Информация в соответствии с § 5 DDG (Закон ФРГ о цифровых услугах) / § 18 абз. 2 MStV",
    blocks: [
      { label: "", value: "{{name}}" },
      { label: "", value: "{{?company}}" },
      { label: "", value: "{{?legalForm}}" },
      { label: "", value: "{{address}}" },
      { label: "", value: "{{city}}" },
      { label: "", value: "{{country}}" },
      { label: "В лице", value: "{{?representative}}" },
      { label: "Контакт", value: `Телефон: {{?phone}}<br/>Электронная почта: {{email}}` },
      {
        label: "{{?registerCourt}}Реестровая запись",
        value: `Запись в торговом реестре.<br/>Реестровый суд: {{registerCourt}}<br/>Номер записи: {{?registerNumber}}`,
      },
      {
        label: "{{?vatId}}Идентификационный номер НДС",
        value: `Идентификационный номер НДС в соответствии с § 27a Закона ФРГ о налоге с оборота: {{vatId}}`,
      },
      {
        label: "Ответственный за содержание в соответствии с § 18 абз. 2 MStV",
        value: "{{name}}<br/>{{address}}, {{city}}",
      },
    ],
    sections: [
      {
        h: "Ответственность за содержание",
        body: [
          `Как поставщик услуг я несу ответственность за собственное содержание на этих страницах в соответствии с общими законами согласно § 7 абз. 1 DDG. Однако согласно §§ 8–10 DDG я как поставщик услуг не обязан проверять переданную или сохранённую чужую информацию или искать обстоятельства, указывающие на противоправную деятельность.`,
          `Обязанности по удалению или блокированию использования информации в соответствии с общими законами остаются в силе. Однако такая ответственность возможна лишь с момента, когда мне стало известно о конкретном нарушении права. При получении сведений о соответствующих нарушениях я незамедлительно удалю это содержание.`,
          `О противоправном содержании, пожалуйста, сообщайте по адресу: {{?reportEmail}}`,
        ],
      },
      {
        h: "Ответственность за ссылки",
        body: [
          `Моё предложение может содержать ссылки на внешние сайты третьих лиц, на содержание которых я не имею влияния. Поэтому за это чужое содержание я также не могу давать никаких гарантий. За содержание связанных страниц всегда отвечает соответствующий поставщик или оператор страниц. Связанные страницы были проверены на возможные нарушения права в момент размещения ссылки. Противоправное содержание на момент размещения ссылки не было обнаружено.`,
        ],
      },
      {
        h: "Авторское право",
        body: [
          `Содержание и произведения, созданные оператором сайта на этих страницах, подпадают под действие немецкого авторского права. Воспроизведение, изменение, распространение и любое использование за пределами авторского права требуют письменного согласия соответствующего автора или создателя.`,
        ],
      },
      {
        h: "Урегулирование споров с потребителями",
        body: [
          `Европейская комиссия предоставляет платформу для онлайн-урегулирования споров (OS): <a href="https://ec.europa.eu/consumers/odr/">https://ec.europa.eu/consumers/odr/</a>.`,
          `Я не готов и не обязан участвовать в процедурах урегулирования споров перед арбитражным органом по делам потребителей.`,
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Datenschutzerklärung — 16 sections (1–15 plus 6a), in the order documented at the top.
// ---------------------------------------------------------------------------
export const DATENSCHUTZ_DOC = {
  de: {
    nav: "Datenschutz",
    title: "Datenschutzerklärung",
    subtitle: "Stand: {{updated}}",
    sections: [
      {
        h: "1. Verantwortlicher",
        body: [
          `Verantwortlicher im Sinne der Datenschutz-Grundverordnung (DSGVO) für die Verarbeitung personenbezogener Daten auf dieser Website ist:`,
          `{{name}}<br/>{{?company}} {{?legalForm}}<br/>{{address}}<br/>{{city}}<br/>{{country}}<br/>E-Mail: {{email}}{{?phone}}`,
          `Bei Fragen zum Datenschutz oder zur Ausübung Ihrer Rechte erreichen Sie mich unter: {{privacyEmail}}`,
          `Diese Website ({{siteDomain}}) wird von mir selbst betrieben. Soweit Dienste Dritter eingebunden sind (siehe die folgenden Abschnitte), werden diese ausdrücklich benannt.`,
        ],
      },
      {
        h: "2. Hosting / VPS",
        body: [
          `Diese Anwendung läuft auf einem eigenen Server (Virtual Private Server, VPS) bzw. — bei einer selbst installierten Kopie — auf dem Rechner oder Server des jeweiligen Betreibers. Der von mir eingesetzte Hosting-Anbieter ist:`,
          `{{?hoster}}<br/>{{?hosterAddress}}<br/>{{?hostingLocation}}`,
          `Der Hosting-Anbieter stellt Rechenleistung, Speicher und Netzwerkzugang bereit und verarbeitet dabei technisch notwendige Verbindungsdaten (insbesondere IP-Adresse, Zeitpunkt der Anfrage). Mit dem Anbieter besteht ein Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO.`,
          `<strong>Zweck:</strong> Bereitstellung und Betrieb dieser Website.<br/><strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung) sowie Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an einem sicheren und stabilen Betrieb).`,
        ],
      },
      {
        h: "3. Cloudflare",
        body: [
          `Diese Website wird über das Netzwerk von Cloudflare, Inc. (101 Townsend St., San Francisco, CA 94107, USA) bereitgestellt und abgesichert. Cloudflare übernimmt als Reverse-Proxy DNS-Auflösung, TLS-Verschlüsselung und Schutz vor Angriffen (u. a. DDoS-Schutz, Web Application Firewall).`,
          `Bei jeder Anfrage verarbeitet Cloudflare die technisch notwendigen Verbindungsdaten, insbesondere die IP-Adresse, Zeitpunkt, angeforderte URL, Browser- und Betriebssystemangaben sowie Sicherheits-Metadaten. Diese Daten werden für den Betrieb, die Sicherheit und die Analyse von Angriffen verwendet.`,
          `{{?cloudflare}}`,
          `<strong>Zweck:</strong> sichere, schnelle und ausfallsichere Auslieferung der Website.<br/><strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an Sicherheit und Verfügbarkeit).<br/><strong>Auftragsverarbeitung:</strong> mit Cloudflare besteht ein Vertrag nach Art. 28 DSGVO.`,
        ],
      },
      {
        h: "4. PostgreSQL / Datenbank",
        body: [
          `Benutzerkonten, Sitzungen, Workflows, Ausführungsprotokolle, Einstellungen und verschlüsselte Zugangsdaten werden in einer Datenbank gespeichert. Standardmäßig ist dies eine SQLite-Datei auf demselben Server; alternativ kann eine PostgreSQL-Datenbank eingesetzt werden — bei einer selbst installierten Kopie auf Wunsch auf einem eigenen Server.`,
          `Zugangsdaten und Geheimnisse (z. B. API-Schlüssel) werden verschlüsselt gespeichert (AES-256-GCM); Passwörter werden ausschließlich als Hash hinterlegt. Der Betreiber der Datenbank hat keinen Zugriff auf entschlüsselte Geheimnisse ohne den Schlüssel der Installation.`,
          `{{?database}}`,
          `<strong>Zweck:</strong> Speicherung und Bereitstellung Ihrer Daten.<br/><strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung), Art. 6 Abs. 1 lit. c DSGVO (gesetzliche Aufbewahrung) und Art. 6 Abs. 1 lit. f DSGVO (Sicherheit des Betriebs).`,
        ],
      },
      {
        h: "5. Registrierung (Nutzerkonto)",
        body: [
          `Für die Nutzung des Workflow-Builders ist eine Registrierung erforderlich. Dabei werden folgende Daten erhoben:`,
          {
            list: [
              "E-Mail-Adresse",
              "Passwort (nur als Hash gespeichert, nie im Klartext)",
              "{{?extraUserFields}}",
              "Zeitpunkt der Registrierung",
            ],
          },
          `Die Angabe dieser Daten ist für die Nutzung erforderlich; ohne sie kann kein Konto angelegt werden.`,
          `<strong>Zweck:</strong> Bereitstellung des Nutzerkontos, Zuordnung Ihrer Workflows und Agenten, Missbrauchsprävention.<br/><strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung bzw. vorvertragliche Maßnahmen) sowie Art. 6 Abs. 1 lit. f DSGVO (Missbrauchsprävention).<br/><strong>Speicherdauer:</strong> bis zur Löschung des Kontos (siehe Ziffer 10 und 11).`,
        ],
      },
      {
        h: "6. Login / Authentifizierung",
        body: [
          `Zur Anmeldung verwende ich einen sicheren Server-Vorgang: Ihr Passwort wird mit einem Salz-Verfahren (scrypt) geprüft; gespeichert wird nur der Hash. Nach erfolgreicher Anmeldung wird eine Sitzung erstellt und technisch als Sitzungs-Cookie gesetzt ({{?sessionTech}}).`,
          `Verwende ich es, so wird das Sitzungs-Cookie ausschließlich dazu genutzt, den Anmeldestatus aufrechtzuerhalten. Optional können Google- oder GitHub-Login (OAuth) genutzt werden; dabei werden nur die für die Anmeldung erforderlichen Angaben (Anbieter, Kennung, E-Mail) verarbeitet.`,
          `Für die Passwort-Zurücksetzung und zur Bestätigung der E-Mail-Adresse werden Einmal-Tokens erzeugt, die nach kurzer Zeit ungültig werden.`,
          `<strong>Zweck:</strong> Authentifizierung und Aufrechterhaltung der Sitzung.<br/><strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung) und Art. 6 Abs. 1 lit. f DSGVO (Sicherheit).<br/><strong>Speicherdauer:</strong> {{?sessionDuration}}`,
        ],
      },
      {
        h: "6a. Verbundene Konten (Google und andere Dienste)",
        body: [
          `In Workflow-Nodes können Sie ein Konto eines Drittanbieters verbinden, etwa Google (Gmail, Google Drive, Google Sheets, Google Kalender, Google Docs), Microsoft, GitHub, Slack oder Notion. Dabei melden Sie sich direkt beim jeweiligen Anbieter an und erteilen W flow dort eine Berechtigung (OAuth). Ihr Passwort für diesen Dienst erhalte ich dabei nie.`,
          `Gespeichert werden ausschließlich:`,
          {
            list: [
              "das Zugriffstoken und ggf. das Aktualisierungstoken des Anbieters — verschlüsselt (AES-256-GCM) in der Datenbank dieser Installation",
              "die E-Mail-Adresse bzw. der Name des verbundenen Kontos, damit Sie es im Node auswählen können",
              "die erteilten Berechtigungen (Scopes)",
            ],
          },
          `<strong>Verwendung:</strong> Die Daten Ihres verbundenen Kontos werden ausschließlich verwendet, um die Aktionen auszuführen, die Sie selbst in Ihren Workflows festlegen — zum Beispiel eine E-Mail über Gmail senden, eine Zeile in Google Sheets schreiben oder einen Kalendereintrag anlegen — und nur, während ein Workflow läuft. Inhalte aus Ihren Konten werden nur im Rahmen dieser Ausführung verarbeitet und, wie jedes Ausführungsergebnis, im Ausführungsprotokoll Ihres eigenen Kontos gespeichert. Sie werden nur an Dienste weitergegeben, die Sie selbst in demselben Workflow konfigurieren.`,
          `Ich verkaufe diese Daten nicht, gebe sie nicht zu Werbezwecken weiter, verwende sie nicht für Werbung und nicht zum Trainieren von KI-Modellen. Eine Einsicht durch Menschen findet nur statt, wenn Sie ausdrücklich zustimmen (z. B. für eine Support-Anfrage), wenn es zur Sicherheit oder zur Aufklärung von Missbrauch erforderlich ist oder wenn das Gesetz es verlangt.`,
          `<strong>Google-Nutzerdaten:</strong> Die Nutzung und Übertragung von Informationen, die W flow über Google-APIs erhält, an andere Apps erfolgt gemäß der Google API Services User Data Policy einschließlich der Anforderungen zur eingeschränkten Nutzung („Limited Use“). Im Original: „W flow's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.“`,
          `<strong>Widerruf:</strong> Sie können eine Verbindung jederzeit trennen — in W flow unter „Credentials“ (die gespeicherten Tokens werden dabei gelöscht) und zusätzlich in den Kontoeinstellungen des Anbieters, bei Google unter <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">myaccount.google.com/permissions</a>.`,
          `<strong>Zweck:</strong> Ausführung der von Ihnen erstellten Workflows mit Ihren eigenen Konten.<br/><strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung) und Art. 6 Abs. 1 lit. a DSGVO (Ihre Einwilligung beim Verbinden des Kontos).<br/><strong>Speicherdauer:</strong> bis Sie die Verbindung trennen oder Ihr Konto löschen.`,
        ],
      },
      {
        h: "7. Bestätigungs-E-Mails",
        body: [
          `Wenn Sie ein Konto anlegen, Ihr Passwort zurücksetzen oder Ihre E-Mail-Adresse bestätigen, sendet der Server eine E-Mail an Ihre hinterlegte Adresse. Die Nachricht enthält einen einmaligen Link bzw. Code.`,
          `Für den Versand nutze ich einen E-Mail-Dienstleister bzw. meinen eigenen SMTP-Server. Übermittelt werden Ihre E-Mail-Adresse, der Versandzeitpunkt und technische Metadaten des Mailservers.`,
          `{{?mailService}}`,
          `<strong>Zweck:</strong> Bestätigung der E-Mail-Adresse, Kontosicherheit, Passwort-Zurücksetzung.<br/><strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. b DSGVO (Vertragserfüllung) und Art. 6 Abs. 1 lit. f DSGVO (Sicherheit des Kontos).<br/><strong>Auftragsverarbeitung:</strong> mit dem eingesetzten Versanddienstleister besteht ein Vertrag nach Art. 28 DSGVO.`,
        ],
      },
      {
        h: "8. IP-Adressen / Server-Logs",
        body: [
          `Bei jedem Aufruf der Website und jeder Ausführung über die API erfasst der Server automatisiert technische Zugriffsdaten:`,
          {
            list: [
              "IP-Adresse des anfragenden Geräts",
              "Datum und Uhrzeit der Anfrage",
              "aufgerufene Seite, Datei oder API-Endpunkt",
              "übertragene Datenmenge und Statuscode",
              "Browsertyp, Browserversion und Betriebssystem",
              "Referrer-URL",
            ],
          },
          `Diese Daten dienen der Sicherstellung eines störungsfreien Betriebs, der Fehleranalyse und der Abwehr von Angriffen. Eine Zusammenführung mit anderen Datenquellen oder eine Auswertung zu Marketingzwecken findet nicht statt.`,
          `<strong>Zweck:</strong> Betriebssicherheit, Fehleranalyse, Missbrauchs- und Angriffserkennung.<br/><strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an einem sicheren und stabilen Betrieb).<br/><strong>Speicherdauer:</strong> {{?logRetention}}`,
        ],
      },
      {
        h: "9. Cookies / lokaler Speicher",
        body: [
          `Diese Website verwendet technisch notwendige Cookies und den lokalen Speicher (localStorage) Ihres Browsers. Konkret:`,
          {
            list: [
              "Sitzungs-Cookie zur Anmeldung (technisch notwendig)",
              "Cookie und lokaler Eintrag Ihrer Cookie-Auswahl (respektiert Ihre Cookie-Entscheidung)",
              "lokale Einstellungen des Editors (z. B. Auto-Speichern, maximale Log-Einträge)",
              "Sprachwahl der Rechtsseiten",
            ],
          },
          `Beim ersten Besuch frage ich mit einem Hinweis-Banner, ob Sie neben den technisch notwendigen Cookies auch optionale Einstellungen zulassen. Ihre Entscheidung können Sie jederzeit in den Einstellungen ändern. Technisch notwendige Cookies sind für den Betrieb erforderlich und werden auf Grundlage von Art. 6 Abs. 1 lit. b bzw. lit. f DSGVO gesetzt; optionale Speicherung erfolgt auf Grundlage Ihrer Einwilligung nach Art. 6 Abs. 1 lit. a DSGVO bzw. § 25 Abs. 1 TTDSG.`,
          `{{?externalData}}`,
          `<strong>Speicherdauer:</strong> {{?sessionDuration}}`,
        ],
      },
      {
        h: "10. Löschung von Daten",
        body: [
          `Sie können Ihr Konto jederzeit selbst löschen. Mit der Löschung werden das Konto, Ihre Workflows, Agenten, Zugangsdaten, Variablen, Daten-Tabellen und die Ausführungsprotokolle entfernt. Veröffentlichte Vorlagen können Sie zusätzlich einzeln aus Ihrem Profil heraus löschen.`,
          `Ihr Konto können Sie löschen über: {{accountDeletion}}. Alternativ genügt eine Nachricht an {{privacyEmail}}; ich lösche die Daten dann unverzüglich, soweit keine gesetzlichen Aufbewahrungspflichten entgegenstehen.`,
          `Sofern gesetzliche Aufbewahrungspflichten bestehen (z. B. handels- oder steuerrechtliche Pflichten bei kostenpflichtigen Leistungen), werden die betroffenen Daten für die Dauer der Pflicht aufbewahrt und danach gelöscht.`,
          `<strong>Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. c DSGVO (gesetzliche Aufbewahrung) und Art. 17 DSGVO (Recht auf Löschung).`,
        ],
      },
      {
        h: "11. Speicherdauer",
        body: [
          `Ich speichere personenbezogene Daten nur so lange, wie es für die genannten Zwecke erforderlich ist oder gesetzliche Pflichten dies vorsehen:`,
          {
            list: [
              "Kontodaten: bis zur Löschung des Kontos",
              "Workflows, Agenten und Konfigurationen: bis zu deren Löschung oder der Kontolöschung",
              "Ausführungsprotokolle: bis zur Löschung oder der Kontolöschung",
              "Server-Logs: {{?logRetention}}",
              "Sitzungen: {{?sessionDuration}}",
              "Cookie-Auswahl: bis zum Widerruf, längstens 180 Tage",
            ],
          },
          `{{?storagePeriods}}`,
          `Nach Ablauf der jeweiligen Frist werden die Daten gelöscht oder so anonymisiert, dass eine Zuordnung zu Ihrer Person nicht mehr möglich ist.`,
        ],
      },
      {
        h: "12. Rechtsgrundlagen",
        body: [
          `Die Verarbeitung personenbezogener Daten stützt sich auf folgende Rechtsgrundlagen der DSGVO:`,
          {
            list: [
              "Art. 6 Abs. 1 lit. a DSGVO — Einwilligung (z. B. optionale Cookies, Social-Login über einen Drittanbieter)",
              "Art. 6 Abs. 1 lit. b DSGVO — Erfüllung eines Vertrags oder Durchführung vorvertraglicher Maßnahmen (Konto, Workflow-Builder, E-Mail-Bestätigung)",
              "Art. 6 Abs. 1 lit. c DSGVO — Erfüllung rechtlicher Verpflichtungen (insbesondere Aufbewahrungspflichten)",
              "Art. 6 Abs. 1 lit. f DSGVO — Wahrung berechtigter Interessen (Betriebssicherheit, Fehleranalyse, Missbrauchsprävention)",
            ],
          },
          `Eine Verarbeitung besonderer Kategorien personenbezogener Daten (Art. 9 DSGVO) findet nicht statt. Soweit Sie eigene Workflows betreiben, die personenbezogene Daten verarbeiten, sind Sie hierfür eigenverantwortlich; der Builder und die von Ihnen konfigurierten Dienste verarbeiten die Daten ausschließlich auf Ihre Veranlassung.`,
        ],
      },
      {
        h: "13. Rechte der Betroffenen",
        body: [
          `Ihnen stehen als betroffene Person folgende Rechte zu:`,
          {
            list: [
              "Art. 15 DSGVO — Auskunft über die verarbeiteten Daten",
              "Art. 16 DSGVO — Berichtigung unrichtiger oder unvollständiger Daten",
              "Art. 17 DSGVO — Löschung Ihrer Daten",
              "Art. 18 DSGVO — Einschränkung der Verarbeitung",
              "Art. 20 DSGVO — Datenübertragbarkeit (Export in einem gängigen Format)",
              "Art. 21 DSGVO — Widerspruch gegen eine auf berechtigtem Interesse beruhende Verarbeitung",
              "Art. 7 Abs. 3 DSGVO — Widerruf einer erteilten Einwilligung mit Wirkung für die Zukunft",
            ],
          },
          `Zur Ausübung dieser Rechte genügt eine Nachricht an {{privacyEmail}}. Ein Export aller Ihrer Daten ist zudem direkt in den Kontoeinstellungen verfügbar. Sie haben außerdem das Recht, sich bei einer Aufsichtsbehörde zu beschweren (siehe Ziffer 15).`,
        ],
      },
      {
        h: "14. Internationale Datenübermittlungen",
        body: [
          `Einige eingebundene Dienste können Daten außerhalb der Europäischen Union bzw. des Europäischen Wirtschaftsraums verarbeiten (z. B. Cloudflare oder ein E-Mail-Dienstleister). Eine Übermittlung erfolgt nur, soweit dies für den Betrieb erforderlich oder gesetzlich erlaubt ist.`,
          `{{?thirdCountryService}}`,
          `Für die Übermittlung in Drittländer stütze ich mich auf geeignete Garantien im Sinne der Art. 44 ff. DSGVO, insbesondere {{?thirdCountryBasis}}.`,
          `Sie können eine Kopie der getroffenen Garantien anfordern unter {{privacyEmail}}.`,
        ],
      },
      {
        h: "15. Aufsichtsbehörde / Beschwerderecht",
        body: [
          `Unbeschadet eines anderweitigen verwaltungsrechtlichen oder gerichtlichen Rechtsbehelfs haben Sie gemäß Art. 77 DSGVO das Recht, sich bei einer Aufsichtsbehörde zu beschweren — insbesondere bei der Behörde Ihres gewöhnlichen Aufenthaltsorts, Ihres Arbeitsplatzes oder des Orts des vermuteten Verstoßes.`,
          `Etwaige Bedenken können Sie zuerst an mich richten; ich kümmere mich dann unverzüglich um Ihr Anliegen.`,
          `{{?authority}}`,
          `{{?securityMeasures}}`,
        ],
      },
    ],
  },

  en: {
    nav: "Privacy",
    title: "Privacy Policy",
    subtitle: "Last updated: {{updated}}",
    sections: [
      {
        h: "1. Controller",
        body: [
          `The controller within the meaning of the General Data Protection Regulation (GDPR) for the processing of personal data on this website is:`,
          `{{name}}<br/>{{?company}} {{?legalForm}}<br/>{{address}}<br/>{{city}}<br/>{{country}}<br/>E-mail: {{email}}{{?phone}}`,
          `For privacy questions or to exercise your rights you can reach me at: {{privacyEmail}}`,
          `This website ({{siteDomain}}) is operated by me. Where third-party services are integrated (see the sections below), they are named explicitly.`,
        ],
      },
      {
        h: "2. Hosting / VPS",
        body: [
          `This application runs on a dedicated server (virtual private server, VPS) or — for a self-installed copy — on the machine or server of the respective operator. The hosting provider I use is:`,
          `{{?hoster}}<br/>{{?hosterAddress}}<br/>{{?hostingLocation}}`,
          `The hosting provider supplies computing power, storage and network access and processes the technical connection data required for this (in particular IP address and time of the request). A data processing agreement pursuant to Art. 28 GDPR is in place with the provider.`,
          `<strong>Purpose:</strong> providing and operating this website.<br/><strong>Legal basis:</strong> Art. 6 (1) lit. b GDPR (performance of a contract) and Art. 6 (1) lit. f GDPR (legitimate interest in secure and stable operation).`,
        ],
      },
      {
        h: "3. Cloudflare",
        body: [
          `This website is delivered and protected through the network of Cloudflare, Inc. (101 Townsend St., San Francisco, CA 94107, USA). As a reverse proxy, Cloudflare provides DNS resolution, TLS encryption and protection against attacks (including DDoS protection and a web application firewall).`,
          `For every request Cloudflare processes the technically necessary connection data, in particular the IP address, time, requested URL, browser and operating system details and security metadata. This data is used for operation, security and attack analysis.`,
          `{{?cloudflare}}`,
          `<strong>Purpose:</strong> secure, fast and resilient delivery of the website.<br/><strong>Legal basis:</strong> Art. 6 (1) lit. f GDPR (legitimate interest in security and availability).<br/><strong>Processor:</strong> a data processing agreement pursuant to Art. 28 GDPR is in place with Cloudflare.`,
        ],
      },
      {
        h: "4. PostgreSQL / database",
        body: [
          `User accounts, sessions, workflows, execution logs, settings and encrypted credentials are stored in a database. By default this is a SQLite file on the same server; alternatively a PostgreSQL database can be used — for a self-installed copy, on your own server if you wish.`,
          `Credentials and secrets (e.g. API keys) are stored encrypted (AES-256-GCM); passwords are stored only as a hash. The database operator has no access to decrypted secrets without the installation's key.`,
          `{{?database}}`,
          `<strong>Purpose:</strong> storing and providing your data.<br/><strong>Legal basis:</strong> Art. 6 (1) lit. b GDPR (performance of a contract), Art. 6 (1) lit. c GDPR (statutory retention) and Art. 6 (1) lit. f GDPR (security of operation).`,
        ],
      },
      {
        h: "5. User registration",
        body: [
          `Using the workflow builder requires registration. The following data is collected:`,
          {
            list: [
              "e-mail address",
              "password (stored only as a hash, never in plain text)",
              "{{?extraUserFields}}",
              "time of registration",
            ],
          },
          `Providing this data is necessary for use; without it no account can be created.`,
          `<strong>Purpose:</strong> providing the user account, attributing your workflows and agents, abuse prevention.<br/><strong>Legal basis:</strong> Art. 6 (1) lit. b GDPR (performance of a contract / pre-contractual measures) and Art. 6 (1) lit. f GDPR (abuse prevention).<br/><strong>Retention period:</strong> until the account is deleted (see sections 10 and 11).`,
        ],
      },
      {
        h: "6. Login / authentication",
        body: [
          `Sign-in uses a secure server-side process: your password is verified with a salted procedure (scrypt); only the hash is stored. After a successful sign-in a session is created and set as a technically necessary session cookie ({{?sessionTech}}).`,
          `The session cookie is used solely to keep you signed in. Optionally, Google or GitHub login (OAuth) can be used; in that case only the data needed to sign in (provider, identifier, e-mail) is processed.`,
          `For password resets and e-mail confirmation, single-use tokens are generated that become invalid after a short time.`,
          `<strong>Purpose:</strong> authentication and maintaining the session.<br/><strong>Legal basis:</strong> Art. 6 (1) lit. b GDPR (performance of a contract) and Art. 6 (1) lit. f GDPR (security).<br/><strong>Retention period:</strong> {{?sessionDuration}}`,
        ],
      },
      {
        h: "6a. Connected accounts (Google and other services)",
        body: [
          `In workflow nodes you can connect an account with a third-party service, such as Google (Gmail, Google Drive, Google Sheets, Google Calendar, Google Docs), Microsoft, GitHub, Slack or Notion. You sign in directly with that service and grant W flow a permission there (OAuth). I never receive your password for that service.`,
          `Only the following is stored:`,
          {
            list: [
              "the service's access token and, where issued, its refresh token — encrypted (AES-256-GCM) in this installation's database",
              "the e-mail address or name of the connected account, so you can pick it on a node",
              "the permissions (scopes) you granted",
            ],
          },
          `<strong>Use:</strong> Data from your connected account is used only to carry out the actions you define in your own workflows — for example sending an e-mail through Gmail, writing a row to Google Sheets or creating a calendar event — and only while a workflow runs. Content from your accounts is processed only within that run and, like every run result, stored in your own account's execution log. It is passed on only to services you configure yourself in the same workflow.`,
          `I do not sell this data, do not share it for advertising, do not use it for advertising and do not use it to train AI models. People only look at it with your explicit consent (for example for a support request), where needed for security or to investigate abuse, or where the law requires it.`,
          `<strong>Google user data:</strong> W flow's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.`,
          `<strong>Revoking access:</strong> you can disconnect an account at any time — in W flow under “Credentials” (the stored tokens are deleted) and in the service's account settings; for Google at <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">myaccount.google.com/permissions</a>.`,
          `<strong>Purpose:</strong> running the workflows you build with your own accounts.<br/><strong>Legal basis:</strong> Art. 6(1)(b) GDPR (performance of a contract) and Art. 6(1)(a) GDPR (your consent when connecting the account).<br/><strong>Storage period:</strong> until you disconnect the account or delete your W flow account.`,
        ],
      },
      {
        h: "7. Confirmation e-mails",
        body: [
          `When you create an account, reset your password or confirm your e-mail address, the server sends an e-mail to the address on file. The message contains a single-use link or code.`,
          `For delivery I use an e-mail service provider or my own SMTP server. The data transmitted includes your e-mail address, the time of sending and technical metadata of the mail server.`,
          `{{?mailService}}`,
          `<strong>Purpose:</strong> confirming the e-mail address, account security, password reset.<br/><strong>Legal basis:</strong> Art. 6 (1) lit. b GDPR (performance of a contract) and Art. 6 (1) lit. f GDPR (account security).<br/><strong>Processor:</strong> a data processing agreement pursuant to Art. 28 GDPR is in place with the delivery provider.`,
        ],
      },
      {
        h: "8. IP addresses / server logs",
        body: [
          `On every visit to the website and every execution through the API, the server automatically records technical access data:`,
          {
            list: [
              "IP address of the requesting device",
              "date and time of the request",
              "page, file or API endpoint accessed",
              "amount of data transferred and status code",
              "browser type, browser version and operating system",
              "referrer URL",
            ],
          },
          `This data serves to ensure trouble-free operation, error analysis and defence against attacks. It is not combined with other data sources or evaluated for marketing purposes.`,
          `<strong>Purpose:</strong> operational security, error analysis, abuse and attack detection.<br/><strong>Legal basis:</strong> Art. 6 (1) lit. f GDPR (legitimate interest in secure and stable operation).<br/><strong>Retention period:</strong> {{?logRetention}}`,
        ],
      },
      {
        h: "9. Cookies / local storage",
        body: [
          `This website uses technically necessary cookies and your browser's local storage (localStorage). Specifically:`,
          {
            list: [
              "session cookie for sign-in (technically necessary)",
              "cookie and local entry storing your cookie choice (honours your decision)",
              "local editor settings (e.g. auto-save, maximum log entries)",
              "language choice of the legal pages",
            ],
          },
          `On your first visit a notice banner asks whether you allow optional preferences in addition to the technically necessary cookies. You can change your decision at any time in the settings. Technically necessary cookies are required for operation and are set on the basis of Art. 6 (1) lit. b and lit. f GDPR; optional storage is based on your consent pursuant to Art. 6 (1) lit. a GDPR.`,
          `{{?externalData}}`,
          `<strong>Retention period:</strong> {{?sessionDuration}}`,
        ],
      },
      {
        h: "10. Data deletion",
        body: [
          `You can delete your account at any time. Deleting it removes the account, your workflows, agents, credentials, variables, data tables and execution logs. Published templates can also be removed individually from your profile.`,
          `You can delete your account via: {{accountDeletion}}. Alternatively, a message to {{privacyEmail}} is sufficient; I will then delete the data without undue delay, unless statutory retention obligations apply.`,
          `Where statutory retention obligations exist (e.g. commercial or tax law for paid services), the affected data is kept for the duration of the obligation and deleted afterwards.`,
          `<strong>Legal basis:</strong> Art. 6 (1) lit. c GDPR (statutory retention) and Art. 17 GDPR (right to erasure).`,
        ],
      },
      {
        h: "11. Storage periods",
        body: [
          `I store personal data only for as long as is necessary for the stated purposes or as required by law:`,
          {
            list: [
              "account data: until the account is deleted",
              "workflows, agents and configurations: until they or the account are deleted",
              "execution logs: until they or the account are deleted",
              "server logs: {{?logRetention}}",
              "sessions: {{?sessionDuration}}",
              "cookie choice: until withdrawn, at most 180 days",
            ],
          },
          `{{?storagePeriods}}`,
          `Once the respective period expires, the data is deleted or anonymised so that it can no longer be attributed to you.`,
        ],
      },
      {
        h: "12. Legal bases",
        body: [
          `The processing of personal data is based on the following legal bases of the GDPR:`,
          {
            list: [
              "Art. 6 (1) lit. a GDPR — consent (e.g. optional cookies, social login via a third party)",
              "Art. 6 (1) lit. b GDPR — performance of a contract or pre-contractual measures (account, workflow builder, e-mail confirmation)",
              "Art. 6 (1) lit. c GDPR — compliance with legal obligations (in particular retention obligations)",
              "Art. 6 (1) lit. f GDPR — legitimate interests (operational security, error analysis, abuse prevention)",
            ],
          },
          `No processing of special categories of personal data (Art. 9 GDPR) takes place. Where you run your own workflows that process personal data, you are responsible for them; the builder and the services you configure process data solely on your instructions.`,
        ],
      },
      {
        h: "13. Data-subject rights",
        body: [
          `As a data subject you have the following rights:`,
          {
            list: [
              "Art. 15 GDPR — access to the data processed",
              "Art. 16 GDPR — rectification of inaccurate or incomplete data",
              "Art. 17 GDPR — erasure of your data",
              "Art. 18 GDPR — restriction of processing",
              "Art. 20 GDPR — data portability (export in a common format)",
              "Art. 21 GDPR — objection to processing based on legitimate interests",
              "Art. 7 (3) GDPR — withdrawal of consent with effect for the future",
            ],
          },
          `To exercise these rights, a message to {{privacyEmail}} is sufficient. An export of all your data is also available directly in the account settings. You also have the right to lodge a complaint with a supervisory authority (see section 15).`,
        ],
      },
      {
        h: "14. International data transfers",
        body: [
          `Some integrated services may process data outside the European Union or the European Economic Area (e.g. Cloudflare or an e-mail provider). Such a transfer only takes place where necessary for operation or permitted by law.`,
          `{{?thirdCountryService}}`,
          `For transfers to third countries I rely on appropriate safeguards within the meaning of Art. 44 et seq. GDPR, in particular {{?thirdCountryBasis}}.`,
          `You can request a copy of the safeguards in place at {{privacyEmail}}.`,
        ],
      },
      {
        h: "15. Supervisory authority / right to complain",
        body: [
          `Without prejudice to any other administrative or judicial remedy, you have the right under Art. 77 GDPR to lodge a complaint with a supervisory authority — in particular in the member state of your habitual residence, place of work or place of the alleged infringement.`,
          `You are welcome to raise any concerns with me first; I will then deal with your request without undue delay.`,
          `{{?authority}}`,
          `{{?securityMeasures}}`,
        ],
      },
    ],
  },

  ru: {
    nav: "Политика",
    title: "Политика конфиденциальности",
    subtitle: "Обновлено: {{updated}}",
    sections: [
      {
        h: "1. Оператор данных",
        body: [
          `Оператором данных в смысле Общего регламента о защите данных (GDPR) для обработки персональных данных на этом сайте является:`,
          `{{name}}<br/>{{?company}} {{?legalForm}}<br/>{{address}}<br/>{{city}}<br/>{{country}}<br/>Электронная почта: {{email}}{{?phone}}`,
          `По вопросам конфиденциальности и для реализации ваших прав вы можете связаться со мной по адресу: {{privacyEmail}}`,
          `Этот сайт ({{siteDomain}}) управляется мной. Если используются сервисы третьих лиц (см. разделы ниже), они прямо названы.`,
        ],
      },
      {
        h: "2. Хостинг / VPS",
        body: [
          `Это приложение работает на собственном сервере (виртуальном частном сервере, VPS) или — если копия установлена самостоятельно — на машине или сервере соответствующего оператора. Используемый мной хостинг-провайдер:`,
          `{{?hoster}}<br/>{{?hosterAddress}}<br/>{{?hostingLocation}}`,
          `Хостинг-провайдер предоставляет вычислительные ресурсы, хранилище и доступ к сети и при этом обрабатывает технически необходимые данные соединения (в частности IP-адрес и время запроса). С провайдером заключён договор об обработке поручений согласно ст. 28 GDPR.`,
          `<strong>Цель:</strong> предоставление и работа этого сайта.<br/><strong>Правовое основание:</strong> ст. 6 абз. 1 лит. b GDPR (исполнение договора) и ст. 6 абз. 1 лит. f GDPR (законный интерес в безопасной и стабильной работе).`,
        ],
      },
      {
        h: "3. Cloudflare",
        body: [
          `Этот сайт доставляется и защищается через сеть Cloudflare, Inc. (101 Townsend St., San Francisco, CA 94107, США). Как обратный прокси Cloudflare обеспечивает разрешение DNS, шифрование TLS и защиту от атак (в том числе защиту от DDoS и межсетевой экран приложений).`,
          `При каждом запросе Cloudflare обрабатывает технически необходимые данные соединения: IP-адрес, время, запрошенный URL, данные браузера и операционной системы, а также метаданные безопасности. Эти данные используются для работы, безопасности и анализа атак.`,
          `{{?cloudflare}}`,
          `<strong>Цель:</strong> безопасная, быстрая и отказоустойчивая доставка сайта.<br/><strong>Правовое основание:</strong> ст. 6 абз. 1 лит. f GDPR (законный интерес в безопасности и доступности).<br/><strong>Обработчик:</strong> с Cloudflare заключён договор об обработке поручений согласно ст. 28 GDPR.`,
        ],
      },
      {
        h: "4. PostgreSQL / база данных",
        body: [
          `Учётные записи, сеансы, рабочие процессы, журналы выполнения, настройки и зашифрованные учётные данные хранятся в базе данных. По умолчанию это файл SQLite на том же сервере; альтернативно может использоваться база PostgreSQL — для самостоятельно установленной копии по желанию на собственном сервере.`,
          `Учётные данные и секреты (например, API-ключи) хранятся в зашифрованном виде (AES-256-GCM); пароли хранятся только в виде хеша. Оператор базы данных не имеет доступа к расшифрованным секретам без ключа установки.`,
          `{{?database}}`,
          `<strong>Цель:</strong> хранение и предоставление ваших данных.<br/><strong>Правовое основание:</strong> ст. 6 абз. 1 лит. b GDPR (исполнение договора), ст. 6 абз. 1 лит. c GDPR (законное хранение) и ст. 6 абз. 1 лит. f GDPR (безопасность работы).`,
        ],
      },
      {
        h: "5. Регистрация пользователей",
        body: [
          `Для использования конструктора рабочих процессов требуется регистрация. При этом собираются следующие данные:`,
          {
            list: [
              "адрес электронной почты",
              "пароль (хранится только в виде хеша, никогда в открытом виде)",
              "{{?extraUserFields}}",
              "время регистрации",
            ],
          },
          `Предоставление этих данных необходимо для использования; без них учётная запись не может быть создана.`,
          `<strong>Цель:</strong> предоставление учётной записи, привязка ваших рабочих процессов и агентов, предотвращение злоупотреблений.<br/><strong>Правовое основание:</strong> ст. 6 абз. 1 лит. b GDPR (исполнение договора / преддоговорные меры) и ст. 6 абз. 1 лит. f GDPR (предотвращение злоупотреблений).<br/><strong>Срок хранения:</strong> до удаления учётной записи (см. разделы 10 и 11).`,
        ],
      },
      {
        h: "6. Вход / аутентификация",
        body: [
          `Для входа используется безопасный серверный процесс: пароль проверяется с использованием соли (scrypt); сохраняется только хеш. После успешного входа создаётся сеанс и технически устанавливается сессионный файл cookie ({{?sessionTech}}).`,
          `Сессионный cookie используется исключительно для поддержания статуса входа. Опционально могут использоваться вход через Google или GitHub (OAuth); при этом обрабатываются только необходимые для входа данные (провайдер, идентификатор, e-mail).`,
          `Для сброса пароля и подтверждения адреса электронной почты создаются одноразовые токены, которые теряют силу через короткое время.`,
          `<strong>Цель:</strong> аутентификация и поддержание сеанса.<br/><strong>Правовое основание:</strong> ст. 6 абз. 1 лит. b GDPR (исполнение договора) и ст. 6 абз. 1 лит. f GDPR (безопасность).<br/><strong>Срок хранения:</strong> {{?sessionDuration}}`,
        ],
      },
      {
        h: "6a. Подключённые аккаунты (Google и другие сервисы)",
        body: [
          `В узлах workflow вы можете подключить аккаунт стороннего сервиса, например Google (Gmail, Google Drive, Google Sheets, Google Календарь, Google Docs), Microsoft, GitHub, Slack или Notion. Вы входите непосредственно у этого сервиса и предоставляете там разрешение W flow (OAuth). Ваш пароль от этого сервиса я никогда не получаю.`,
          `Сохраняется только следующее:`,
          {
            list: [
              "токен доступа сервиса и, если выдан, токен обновления — в зашифрованном виде (AES-256-GCM) в базе данных этой установки",
              "адрес электронной почты или имя подключённого аккаунта, чтобы вы могли выбрать его в узле",
              "предоставленные разрешения (scopes)",
            ],
          },
          `<strong>Использование:</strong> данные подключённого аккаунта используются исключительно для выполнения действий, которые вы сами задаёте в своих workflow — например, отправки письма через Gmail, записи строки в Google Sheets или создания события в календаре — и только во время выполнения workflow. Содержимое ваших аккаунтов обрабатывается только в рамках этого выполнения и, как любой результат выполнения, сохраняется в журнале выполнений вашего собственного аккаунта. Оно передаётся только сервисам, которые вы сами настроили в том же workflow.`,
          `Я не продаю эти данные, не передаю их в рекламных целях, не использую их для рекламы и для обучения моделей ИИ. Люди просматривают их только с вашего явного согласия (например, по обращению в поддержку), если это необходимо для безопасности или расследования злоупотреблений, либо если этого требует закон.`,
          `<strong>Данные пользователей Google:</strong> использование и передача другим приложениям информации, полученной W flow через API Google, осуществляется в соответствии с Google API Services User Data Policy, включая требования ограниченного использования (Limited Use). Оригинал: «W flow's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener">Google API Services User Data Policy</a>, including the Limited Use requirements.»`,
          `<strong>Отзыв доступа:</strong> вы можете в любой момент отключить аккаунт — в W flow в разделе «Credentials» (сохранённые токены удаляются) и в настройках аккаунта сервиса; для Google — на странице <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">myaccount.google.com/permissions</a>.`,
          `<strong>Цель:</strong> выполнение созданных вами workflow с вашими собственными аккаунтами.<br/><strong>Правовое основание:</strong> ст. 6(1)(b) GDPR (исполнение договора) и ст. 6(1)(a) GDPR (ваше согласие при подключении аккаунта).<br/><strong>Срок хранения:</strong> до отключения аккаунта или удаления вашего аккаунта W flow.`,
        ],
      },
      {
        h: "7. Подтверждающие письма",
        body: [
          `Когда вы создаёте учётную запись, сбрасываете пароль или подтверждаете адрес электронной почты, сервер отправляет письмо на указанный адрес. Сообщение содержит одноразовую ссылку или код.`,
          `Для отправки я использую почтовый сервис или собственный SMTP-сервер. Передаются ваш адрес электронной почты, время отправки и технические метаданные почтового сервера.`,
          `{{?mailService}}`,
          `<strong>Цель:</strong> подтверждение адреса электронной почты, безопасность учётной записи, сброс пароля.<br/><strong>Правовое основание:</strong> ст. 6 абз. 1 лит. b GDPR (исполнение договора) и ст. 6 абз. 1 лит. f GDPR (безопасность учётной записи).<br/><strong>Обработчик:</strong> с почтовым провайдером заключён договор об обработке поручений согласно ст. 28 GDPR.`,
        ],
      },
      {
        h: "8. IP-адреса / серверные журналы",
        body: [
          `При каждом обращении к сайту и каждом выполнении через API сервер автоматически фиксирует технические данные доступа:`,
          {
            list: [
              "IP-адрес запрашивающего устройства",
              "дата и время запроса",
              "запрошенная страница, файл или конечная точка API",
              "объём переданных данных и код состояния",
              "тип и версия браузера, операционная система",
              "URL-источник (referrer)",
            ],
          },
          `Эти данные служат обеспечению бесперебойной работы, анализу ошибок и защите от атак. Объединение с другими источниками данных или оценка в маркетинговых целях не производится.`,
          `<strong>Цель:</strong> безопасность работы, анализ ошибок, выявление злоупотреблений и атак.<br/><strong>Правовое основание:</strong> ст. 6 абз. 1 лит. f GDPR (законный интерес в безопасной и стабильной работе).<br/><strong>Срок хранения:</strong> {{?logRetention}}`,
        ],
      },
      {
        h: "9. Файлы cookie / локальное хранилище",
        body: [
          `Этот сайт использует технически необходимые файлы cookie и локальное хранилище (localStorage) вашего браузера. Конкретно:`,
          {
            list: [
              "сессионный cookie для входа (технически необходим)",
              "cookie и локальная запись вашего выбора cookie (учитывает ваше решение)",
              "локальные настройки редактора (например, автосохранение, лимит записей журнала)",
              "выбор языка правовых страниц",
            ],
          },
          `При первом посещении баннер-уведомление спрашивает, разрешаете ли вы дополнительные настройки помимо технически необходимых cookie. Вы можете изменить решение в любой момент в настройках. Технически необходимые cookie требуются для работы и устанавливаются на основании ст. 6 абз. 1 лит. b и лит. f GDPR; опциональное хранение основано на вашем согласии согласно ст. 6 абз. 1 лит. a GDPR.`,
          `{{?externalData}}`,
          `<strong>Срок хранения:</strong> {{?sessionDuration}}`,
        ],
      },
      {
        h: "10. Удаление данных",
        body: [
          `Вы можете удалить свою учётную запись в любой момент. При удалении удаляются учётная запись, ваши рабочие процессы, агенты, учётные данные, переменные, таблицы данных и журналы выполнения. Опубликованные шаблоны вы можете дополнительно удалить по отдельности из своего профиля.`,
          `Удалить учётную запись можно через: {{accountDeletion}}. Альтернативно достаточно сообщения на адрес {{privacyEmail}}; после этого я незамедлительно удалю данные, если не действуют законные обязанности хранения.`,
          `Если существуют законные обязанности хранения (например, торговое или налоговое право для платных услуг), соответствующие данные хранятся в течение срока обязанности и затем удаляются.`,
          `<strong>Правовое основание:</strong> ст. 6 абз. 1 лит. c GDPR (законное хранение) и ст. 17 GDPR (право на удаление).`,
        ],
      },
      {
        h: "11. Сроки хранения",
        body: [
          `Я храню персональные данные лишь столько, сколько это необходимо для указанных целей или предусмотрено законом:`,
          {
            list: [
              "данные учётной записи: до удаления учётной записи",
              "рабочие процессы, агенты и конфигурации: до их удаления или удаления учётной записи",
              "журналы выполнения: до их удаления или удаления учётной записи",
              "серверные журналы: {{?logRetention}}",
              "сеансы: {{?sessionDuration}}",
              "выбор cookie: до отзыва, максимум 180 дней",
            ],
          },
          `{{?storagePeriods}}`,
          `По истечении соответствующего срока данные удаляются или анонимизируются так, что отнести их к вашей личности больше невозможно.`,
        ],
      },
      {
        h: "12. Правовые основания",
        body: [
          `Обработка персональных данных основывается на следующих правовых основаниях GDPR:`,
          {
            list: [
              "ст. 6 абз. 1 лит. a GDPR — согласие (например, опциональные cookie, социальный вход через третью сторону)",
              "ст. 6 абз. 1 лит. b GDPR — исполнение договора или преддоговорные меры (учётная запись, конструктор, подтверждение e-mail)",
              "ст. 6 абз. 1 лит. c GDPR — соблюдение правовых обязанностей (в частности, обязанности хранения)",
              "ст. 6 абз. 1 лит. f GDPR — законные интересы (безопасность работы, анализ ошибок, предотвращение злоупотреблений)",
            ],
          },
          `Обработка особых категорий персональных данных (ст. 9 GDPR) не производится. Если вы запускаете собственные рабочие процессы, обрабатывающие персональные данные, ответственность за них несёте вы; конструктор и настроенные вами сервисы обрабатывают данные исключительно по вашему поручению.`,
        ],
      },
      {
        h: "13. Права субъектов данных",
        body: [
          `Как субъект данных вы обладаете следующими правами:`,
          {
            list: [
              "ст. 15 GDPR — доступ к обрабатываемым данным",
              "ст. 16 GDPR — исправление неточных или неполных данных",
              "ст. 17 GDPR — удаление ваших данных",
              "ст. 18 GDPR — ограничение обработки",
              "ст. 20 GDPR — переносимость данных (экспорт в общепринятом формате)",
              "ст. 21 GDPR — возражение против обработки на основании законных интересов",
              "ст. 7 абз. 3 GDPR — отзыв согласия на будущее",
            ],
          },
          `Для реализации этих прав достаточно сообщения на адрес {{privacyEmail}}. Экспорт всех ваших данных также доступен непосредственно в настройках учётной записи. Вы также вправе подать жалобу в надзорный орган (см. раздел 15).`,
        ],
      },
      {
        h: "14. Международная передача данных",
        body: [
          `Некоторые подключённые сервисы могут обрабатывать данные за пределами Европейского союза или Европейской экономической зоны (например, Cloudflare или почтовый сервис). Передача происходит только в том случае, если это необходимо для работы или разрешено законом.`,
          `{{?thirdCountryService}}`,
          `Для передачи в третьи страны я полагаюсь на надлежащие гарантии в смысле ст. 44 и след. GDPR, в частности {{?thirdCountryBasis}}.`,
          `Копию имеющихся гарантий можно запросить по адресу {{privacyEmail}}.`,
        ],
      },
      {
        h: "15. Надзорный орган / право на жалобу",
        body: [
          `Без ущерба для любого иного административного или судебного средства защиты вы вправе согласно ст. 77 GDPR подать жалобу в надзорный орган — в частности в государстве вашего обычного места жительства, места работы или места предполагаемого нарушения.`,
          `Возможные сомнения вы можете сначала адресовать мне; я незамедлительно займусь вашим обращением.`,
          `{{?authority}}`,
          `{{?securityMeasures}}`,
        ],
      },
    ],
  },
};
