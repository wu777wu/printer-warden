window.__ModuleLoader__.load({
  id: '@local/printer-warden',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useRef, useState, useCallback } = React;

    const NS = 'printerWarden';
    const API = '/printer-warden/api';
    const TContext = React.createContext((key) => key);

    const DICT = {
      zh: {
        title: '打印机管家',
        subtitle: '自动找打印机、绑成默认；断电换 IP 也不用再找',
        refresh: '刷新',
        scan: '扫描局域网',
        scanning: '正在扫描局域网…',
        scanningShort: '扫描中…',
        bind: '绑定并设为默认',
        binding: '正在绑定…',
        setDefault: '设为默认',
        fix: '修复（换 IP 后）',
        current: '当前打印队列',
        port: '打印端口',
        status: '连接状态',
        online: '在线',
        offline: '离线',
        unknown: '未知',
        isDefault: '默认打印机',
        yes: '是',
        no: '否',
        candidates: '发现的局域网打印机',
        noCandidates: '还没有发现打印机。确认打印机已开机、和这台电脑在同一个局域网，然后点「扫描局域网」。',
        notScanned: '尚未扫描',
        lastScan: '上次扫描',
        uacNote: '一般不需要管理员；只有系统拒绝写打印端口时才会弹一次 UAC。',
        moved: '打印机换了 IP',
        movedHint: '旧地址 {old} 连不上，但 {ip} 上发现了同一台打印机。点「修复」把端口改过去。',
        fixedName: '已按名称固定',
        fixedNameHint: '端口用的是名称 {host}，打印机重新上电换 IP 也不会影响打印。',
        printerOffline: '打印机离线',
        printerOfflineHint: '先确认打印机已开机；若已开机，点「扫描局域网」找它现在的位置。',
        spooler: '打印服务',
        error: '出错了',
        cancelled: '已取消管理员授权。',
        via: '识别依据',
        ip: 'IP',
        mac: 'MAC',
        ports: '端口',
        scanDone: '扫描完成，发现 {n} 台',
        queueMissing: '没有找到本地打印队列，请先在 Windows 里安装这台打印机的驱动。',
        applyOk: '已绑定：{queue}',
        defaultOk: '已设为默认打印机：{queue}',
        refreshHint: '状态每 4 秒自动刷新',
      },
      en: {
        title: 'Printer Warden',
        subtitle: 'Finds the shared printer, makes it default, survives IP changes',
        refresh: 'Refresh',
        scan: 'Scan LAN',
        scanning: 'Scanning the LAN…',
        scanningShort: 'Scanning…',
        bind: 'Bind and set default',
        binding: 'Binding…',
        setDefault: 'Set as default',
        fix: 'Repair (IP changed)',
        current: 'Print queue',
        port: 'Port',
        status: 'Status',
        online: 'Online',
        offline: 'Offline',
        unknown: 'Unknown',
        isDefault: 'Default printer',
        yes: 'Yes',
        no: 'No',
        candidates: 'Printers found on the LAN',
        noCandidates: 'No printer found yet. Make sure it is powered on and on the same LAN, then press "Scan LAN".',
        notScanned: 'Not scanned yet',
        lastScan: 'Last scan',
        uacNote: 'Usually no administrator prompt; UAC appears only if Windows refuses the port change.',
        moved: 'The printer changed IP',
        movedHint: 'The old address {old} is unreachable, but the same printer answers at {ip}. Press "Repair" to move the port.',
        fixedName: 'Pinned by name',
        fixedNameHint: 'The port uses {host}, so a power cycle that changes the IP does not affect printing.',
        printerOffline: 'Printer offline',
        printerOfflineHint: 'Check that it is powered on; if it is, press "Scan LAN" to find its current address.',
        spooler: 'Print service',
        error: 'Error',
        cancelled: 'Administrator consent was cancelled.',
        via: 'Evidence',
        ip: 'IP',
        mac: 'MAC',
        ports: 'Ports',
        scanDone: 'Scan finished: {n} found',
        queueMissing: 'No local print queue found. Install the printer driver in Windows first.',
        applyOk: 'Bound: {queue}',
        defaultOk: 'Default printer: {queue}',
        refreshHint: 'Refreshes every 4 seconds',
      },
    };

    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (_m, key) => (values && values[key] !== undefined ? String(values[key]) : ''));
    }

    async function call(action, payload) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(payload || {}) }),
      });
      return response.json().catch(() => ({ ok: false, error: 'bad-response' }));
    }

    function Badge({ tone, children }) {
      return h('span', { className: `pw-badge pw-badge-${tone}` }, children);
    }

    function Row({ label, children }) {
      return h(
        'div',
        { className: 'pw-row' },
        h('div', { className: 'pw-row-label' }, label),
        h('div', { className: 'pw-row-value' }, children),
      );
    }

    function PrinterIcon(props) {
      const size = props && props.size ? props.size : 18;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M7 8V4.8c0-.44.36-.8.8-.8h8.4c.44 0 .8.36.8.8V8' }),
        h('rect', { x: 3.6, y: 8, width: 16.8, height: 8.2, rx: 1.8 }),
        h('path', { d: 'M7 13h10v6.2c0 .44-.36.8-.8.8H7.8a.8.8 0 0 1-.8-.8z' }),
        h('path', { d: 'M9.5 16.2h5' }),
      );
    }

    function Panel() {
      const t = React.useContext(TContext);
      const tt = (key) => t(key);
      const [state, setState] = useState(null);
      const [busy, setBusy] = useState(null);
      const [error, setError] = useState(null);
      const [flash, setFlash] = useState(null);
      const mounted = useRef(true);
      const autoScanned = useRef(false);

      useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      const applyState = useCallback((data) => {
        if (!mounted.current || !data) return;
        setState(data.state ? data.state : data);
      }, []);

      const refresh = useCallback(async () => {
        try {
          const data = await call('state');
          if (!mounted.current) return;
          applyState(data);
          if (data && data.ok === false) setError(data.message || data.error || 'error');
        } catch (err) {
          if (mounted.current) setError(String(err && err.message ? err.message : err));
        }
      }, [applyState]);

      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 4000);
        return () => clearInterval(timer);
      }, [refresh]);

      const scan = useCallback(async () => {
        setBusy('scan');
        setError(null);
        setFlash(null);
        try {
          const data = await call('scan');
          if (!mounted.current) return;
          applyState(data);
          if (data && data.ok === false) setError(data.message || data.error || 'scan failed');
          else setFlash('scanDone');
        } catch (err) {
          if (mounted.current) setError(String(err && err.message ? err.message : err));
        } finally {
          if (mounted.current) setBusy(null);
        }
      }, [applyState]);

      useEffect(() => {
        if (!state || autoScanned.current) return;
        if (state.scannedAt || state.scanning || busy) return;
        autoScanned.current = true;
        scan();
      }, [state, busy, scan]);

      const act = useCallback(
        async (action, ip, flashKey) => {
          setBusy(action);
          setError(null);
          setFlash(null);
          try {
            const data = await call(action, ip ? { ip } : undefined);
            if (!mounted.current) return;
            applyState(data);
            if (data && data.ok === false) {
              setError(data.error === 'elevation-cancelled' ? tt('cancelled') : data.message || data.error || 'error');
            } else {
              setFlash(flashKey || 'applyOk');
            }
          } catch (err) {
            if (mounted.current) setError(String(err && err.message ? err.message : err));
          } finally {
            if (mounted.current) setBusy(null);
          }
        },
        [applyState, t],
      );

      if (!state) {
        return h('div', { className: 'pw-root' }, h('div', { className: 'pw-loading' }, tt('scanningShort')));
      }

      const queue = state.queue;
      const online = queue ? queue.online : null;
      const portHost = queue ? queue.portHost : null;
      const pinnedByName = !!portHost && !/^\d{1,3}(\.\d{1,3}){3}$/.test(portHost);
      const movedTo = state.movedTo;

      const statusTone = online === true ? 'ok' : online === false ? 'bad' : 'idle';
      const statusText = online === true ? tt('online') : online === false ? tt('offline') : tt('unknown');

      const hint = (() => {
        if (!queue) return { tone: 'bad', title: tt('queueMissing'), text: '' };
        if (movedTo) {
          return { tone: 'warn', title: tt('moved'), text: fmt(tt('movedHint'), { old: portHost || '—', ip: movedTo.ip }) };
        }
        if (online === true) return { tone: 'ok', title: tt('online'), text: '' };
        if (online === false) {
          return { tone: 'warn', title: tt('printerOffline'), text: tt('printerOfflineHint') };
        }
        return null;
      })();

      const lastScan = state.scannedAt ? new Date(state.scannedAt).toLocaleTimeString() : tt('notScanned');

      return h(
        'div',
        { className: 'pw-root' },
        h(
          'header',
          { className: 'pw-head' },
          h(
            'div',
            null,
            h('h1', { className: 'pw-title' }, tt('title')),
            h('p', { className: 'pw-sub' }, tt('subtitle')),
          ),
          h(
            'div',
            { className: 'pw-head-actions' },
            h(
              'button',
              { className: 'pw-btn pw-btn-ghost', onClick: scan, disabled: busy === 'scan' },
              busy === 'scan' ? tt('scanningShort') : tt('scan'),
            ),
            h('button', { className: 'pw-btn pw-btn-ghost', onClick: refresh, disabled: !!busy }, tt('refresh')),
          ),
        ),

        error ? h('div', { className: 'pw-banner pw-banner-bad' }, h('strong', null, tt('error') + '：'), error) : null,
        flash === 'applyOk' && queue
          ? h('div', { className: 'pw-banner pw-banner-ok' }, fmt(tt('applyOk'), { queue: queue.name }))
          : null,
        flash === 'defaultOk' && queue
          ? h('div', { className: 'pw-banner pw-banner-ok' }, fmt(tt('defaultOk'), { queue: queue.name }))
          : null,

        h(
          'section',
          { className: 'pw-card' },
          h(
            'div',
            { className: 'pw-card-head' },
            h('div', { className: 'pw-card-title' }, tt('current')),
            h(Badge, { tone: statusTone }, statusText),
            queue && queue.isDefault ? h(Badge, { tone: 'ok' }, tt('isDefault')) : null,
          ),
          queue
            ? h(
                'div',
                { className: 'pw-rows' },
                h(Row, { label: tt('current') }, queue.name),
                h(
                  Row,
                  { label: tt('port') },
                  h('code', null, queue.port || '—'),
                  h(
                    'span',
                    { className: 'pw-dim' },
                    portHost ? ` → ${portHost}${queue.portNumber ? ':' + queue.portNumber : ''}` : '',
                  ),
                ),
                h(Row, { label: tt('spooler') }, state.spooler || '—'),
                h(
                  Row,
                  { label: tt('isDefault') },
                  queue.isDefault ? tt('yes') : tt('no'),
                  queue.isDefault
                    ? null
                    : h(
                        'button',
                        {
                          className: 'pw-btn pw-btn-mini',
                          onClick: () => act('default', null, 'defaultOk'),
                          disabled: !!busy,
                          style: { marginLeft: 10 },
                        },
                        tt('setDefault'),
                      ),
                ),
                pinnedByName
                  ? h(
                      'div',
                      { className: 'pw-pin' },
                      h('strong', null, tt('fixedName')),
                      h('span', null, fmt(tt('fixedNameHint'), { host: portHost })),
                    )
                  : null,
              )
            : h('div', { className: 'pw-empty' }, tt('queueMissing')),
        ),

        hint
          ? h(
              'div',
              { className: `pw-hint pw-hint-${hint.tone}` },
              h('div', { className: 'pw-hint-title' }, hint.title),
              hint.text ? h('div', { className: 'pw-hint-text' }, hint.text) : null,
              movedTo
                ? h(
                    'button',
                    { className: 'pw-btn pw-btn-primary', onClick: () => act('bind', movedTo.ip, 'applyOk'), disabled: !!busy },
                    busy === 'bind' ? tt('binding') : tt('fix'),
                  )
                : null,
            )
          : null,

        h(
          'section',
          { className: 'pw-card' },
          h(
            'div',
            { className: 'pw-card-head' },
            h('div', { className: 'pw-card-title' }, tt('candidates')),
            h(
              'div',
              { className: 'pw-dim' },
              tt('lastScan') + '：' + lastScan + (busy === 'scan' ? ' · ' + tt('scanningShort') : ''),
            ),
          ),
          state.candidates && state.candidates.length
            ? h(
                'ul',
                { className: 'pw-list' },
                state.candidates.map((c) =>
                  h(
                    'li',
                    { key: c.ip, className: 'pw-item' },
                    h(
                      'div',
                      { className: 'pw-item-main' },
                      h('div', { className: 'pw-item-title' }, c.name || c.model || c.ip),
                      h(
                        'div',
                        { className: 'pw-item-sub' },
                        h('span', null, `${tt('ip')} ${c.ip}`),
                        c.mac ? h('span', null, `${tt('mac')} ${c.mac}`) : null,
                        c.ports && c.ports.length ? h('span', null, `${tt('ports')} ${c.ports.join('/')}`) : null,
                        c.evidence && c.evidence.length ? h('span', null, `${tt('via')}: ${c.evidence.join(', ')}`) : null,
                      ),
                    ),
                    h(
                      'button',
                      { className: 'pw-btn pw-btn-primary', onClick: () => act('bind', c.ip, 'applyOk'), disabled: !!busy },
                      busy === 'bind' ? tt('binding') : tt('bind'),
                    ),
                  ),
                ),
              )
            : h('div', { className: 'pw-empty' }, busy === 'scan' ? tt('scanning') : tt('noCandidates')),
        ),

        h('footer', { className: 'pw-foot' }, tt('uacNote') + ' · ' + tt('refreshHint')),
      );
    }

    const CSS = `
      .pw-root{height:100%;overflow:auto;padding:26px 30px 40px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
      .pw-root *{box-sizing:border-box}
      .pw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;max-width:980px;margin:0 auto 18px}
      .pw-title{font-size:20px;font-weight:600;margin:0}
      .pw-sub{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12.5px}
      .pw-head-actions{display:flex;gap:8px;flex-shrink:0}
      .pw-card{max-width:980px;margin:0 auto 14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:16px 18px}
      .pw-card-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}
      .pw-card-title{font-weight:600;font-size:13.5px}
      .pw-rows{display:flex;flex-direction:column;gap:8px}
      .pw-row{display:flex;gap:14px;align-items:baseline}
      .pw-row-label{width:104px;flex-shrink:0;color:var(--dsw-alias-label-secondary)}
      .pw-row-value{min-width:0;word-break:break-all}
      .pw-row-value code{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-2);border-radius:4px;padding:1px 5px}
      .pw-dim{color:var(--dsw-alias-label-secondary)}
      .pw-badge{display:inline-flex;align-items:center;padding:1px 8px;border-radius:999px;font-size:11.5px;border:1px solid transparent}
      .pw-badge-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent)}
      .pw-badge-bad{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent)}
      .pw-badge-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent)}
      .pw-badge-idle{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
      .pw-btn{font:inherit;border-radius:7px;padding:6px 12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
      .pw-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
      .pw-btn:disabled{opacity:.55;cursor:default}
      .pw-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
      .pw-btn-ghost{background:var(--dsw-alias-bg-layer-1)}
      .pw-btn-mini{padding:2px 9px;font-size:12px}
      .pw-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
      .pw-item{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}
      .pw-item:first-child{border-top:none}
      .pw-item-main{flex:1;min-width:0}
      .pw-item-title{font-weight:560}
      .pw-item-sub{display:flex;flex-wrap:wrap;gap:10px;color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}
      .pw-empty{color:var(--dsw-alias-label-secondary);padding:6px 0}
      .pw-hint{max-width:980px;margin:0 auto 14px;border-radius:10px;padding:12px 16px;border:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
      .pw-hint-ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent)}
      .pw-hint-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,transparent)}
      .pw-hint-bad{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
      .pw-hint-title{font-weight:600}
      .pw-hint-text{color:var(--dsw-alias-label-secondary);flex:1;min-width:240px}
      .pw-banner{max-width:980px;margin:0 auto 14px;padding:10px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1)}
      .pw-banner-bad{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary)}
      .pw-banner-ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);color:var(--dsw-alias-state-success-primary)}
      .pw-pin{display:flex;flex-direction:column;gap:2px;margin-top:6px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px}
      .pw-pin strong{color:var(--dsw-alias-state-success-primary);font-weight:600}
      .pw-foot{max-width:980px;margin:18px auto 0;color:var(--dsw-alias-label-secondary);font-size:11.5px}
      .pw-loading{padding:40px;text-align:center;color:var(--dsw-alias-label-secondary)}
    `;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        if (ctx.locale && ctx.locale.register) {
          ctx.effect(() => ctx.locale.register(NS, DICT), 'printer-warden: dictionaries');
        }
        const t = (key) => {
          try {
            return ctx.locale.bind(NS)(key);
          } catch {
            return DICT.zh[key] || key;
          }
        };

        const styleEl = document.createElement('style');
        styleEl.setAttribute('data-printer-warden', '');
        styleEl.textContent = CSS;
        document.head.appendChild(styleEl);
        ctx.effect(() => () => styleEl.remove(), 'printer-warden: styles');

        const PanelWithT = (props) => h(TContext.Provider, { value: t }, h(Panel, props));

        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                { name: 'sidebar.panellist', id: 'printer-warden', order: 6, label: () => t('title') },
                PrinterIcon,
              ),
            ),
          'printer-warden: sidebar entry',
        );

        ctx.effect(
          () => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'printer-warden' }, PanelWithT)),
          'printer-warden: main panel',
        );
      },
    };
  },
});
