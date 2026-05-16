# T2 Smoke Test — Debounced Gist Publish Latency

## Test Run: 2026-05-16T08:32:44Z

### Timeline

| Event | Timestamp (UTC) | Delta |
|-------|-----------------|-------|
| kanban_comment triggered hook | 2026-05-16T08:32:44.683Z | T0 |
| Debounce runner woke, fired publish | 2026-05-16T08:33:14.716Z | +30.0s |
| Gist publish completed OK | 2026-05-16T08:33:16.991Z | +32.3s |

### Measured Latencies

- **Hook processing time:** 0.004s (well under 1s limit)
- **Debounce window:** 30s (as configured)
- **Gist publish duration:** 2.3s
- **Total kanban-write-to-gist-updated:** 32.3s

### End-to-end latency estimate (kanban write → Notion row updated)

- Debounce + publish: ~32s
- tasksDelta poll interval: 1 min (worst case adds 60s)
- **Total worst-case:** ~92s ≈ 1.5 min
- **Total best-case:** ~32s (if tasksDelta polls immediately after publish)
- **Previous latency:** ~16 min (15min cron publish + 1min tasksDelta)
- **Improvement:** ~10x faster (16min → ~1.5min worst case)

### Coalescing Verification

The debounce correctly coalesced 1 pending event in this test. Multiple rapid
kanban writes within a 30s window will be batched into a single gist publish.

### Validation Gates

- [x] `rg -n "upsertTask" local/` returns **zero** matches (only *.py files)
- [x] `drain_kanban_retry_queue.py` no longer exists
- [x] No cron job referencing drain script (drain cron already removed from registry)
- [x] Hook imports without error (`importlib.util.spec_from_file_location`)
- [x] Gist publish fires within ~60s of kanban write (measured: 32.3s)
- [x] Log message format correct: "kanban_to_notion: debounced publish_gist scheduled (window=30s, pending=N)"
