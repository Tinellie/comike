import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, FormControlLabel, IconButton, MenuItem,
  Paper, Popover, Stack, SvgIcon, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, TableSortLabel, TextField, Tooltip, Typography,
} from '@mui/material'
import type { BoothListItem, BoothOptions, BoothPage, BoothSummary } from './api'
import { locationLabel, readBoothApi } from './api'
import BoothDetail from './BoothDetail'
import { BoothImages, BoothLinks } from './BoothMedia'
import { useAuth } from '../auth/context'
import ColourPreferences from './ColourPreferences'
import PixivMenu from '../social/PixivMenu'

function BoothHeader({ children }: { children?: ReactNode }) {
  return <Stack direction="row" sx={{ mb: 2, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
    <Box><Typography variant="h4" sx={{ fontWeight: 700 }}>Booth List</Typography><Typography variant="body2" color="text.secondary">Comiket 社团列表</Typography></Box>
    <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>{children}</Stack>
  </Stack>
}

function BoothTable({ options, eventControl }: { options: BoothOptions; eventControl: ReactNode }) {
  const { user } = useAuth()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'name' | 'location' | 'genre' | 'colour'>('location')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [days, setDays] = useState<string[] | null>(null)
  const [halls, setHalls] = useState<string[] | null>(null)
  const [genres, setGenres] = useState<(string | null)[] | null>(null)
  const [availableColours, setAvailableColours] = useState(options.colours)
  const [colourRevision, setColourRevision] = useState(0)
  const [colours, setColours] = useState<(string | null)[] | null>(() => user ? options.colours : null)
  const allColours: (string | null)[] = [...availableColours, null]
  const [filterKind, setFilterKind] = useState<'location' | 'genre' | 'colour'>('location')
  const [filterAnchor, setFilterAnchor] = useState<HTMLElement | null>(null)
  const [items, setItems] = useState<BoothListItem[]>([])
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<BoothSummary | null>(null)
  const sentinel = useRef<HTMLDivElement | null>(null)
  const request = useRef<AbortController | null>(null)
  const inFlight = useRef(false)
  const query = new URLSearchParams({ eventId: options.event!.eventId, sort, direction, limit: '40' })
  if (search.trim()) query.set('search', search.trim())
  if (days !== null) query.set('days', days.join(','))
  if (halls !== null) query.set('halls', halls.join(','))
  if (genres !== null) query.set('genres', JSON.stringify(genres))
  if (colours !== null) query.set('colours', JSON.stringify(colours))
  const queryString = query.toString()

  const loadPage = useCallback((offset: number, signal: AbortSignal) => {
    inFlight.current = true
    return readBoothApi<BoothPage>(`?${queryString}&offset=${offset}`, signal).then(result => {
      if (signal.aborted) return
      setItems(previous => {
        if (offset === 0) return result.items
        const existingIds = new Set(previous.map(item => item.id))
        return [...previous, ...result.items.filter(item => !existingIds.has(item.id))]
      })
      setTotal(result.total)
      setNextOffset(result.nextOffset)
    }).catch((reason: unknown) => {
      if (signal.aborted) return
      console.error('Booth list failed:', reason)
      setError(reason instanceof Error ? reason.message : '列表加载失败')
    }).finally(() => {
      if (!signal.aborted) { inFlight.current = false; setLoading(false) }
    })
  }, [queryString])

  useEffect(() => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    void loadPage(0, controller.signal)
    return () => { controller.abort(); request.current?.abort() }
  }, [loadPage, colourRevision])

  const loadMore = useCallback(() => {
    if (inFlight.current || nextOffset === null) return
    setLoading(true)
    setError(null)
    const controller = new AbortController()
    request.current = controller
    void loadPage(nextOffset, controller.signal)
  }, [loadPage, nextOffset])

  useEffect(() => {
    if (!sentinel.current || loading || error || nextOffset === null || !items.length) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMore()
    }, { rootMargin: '400px' })
    observer.observe(sentinel.current)
    return () => observer.disconnect()
  }, [items.length, loading, error, nextOffset, loadMore])

  function resetPage() {
    request.current?.abort()
    inFlight.current = false
    setItems([])
    setTotal(0)
    setNextOffset(0)
    setLoading(true)
    setError(null)
  }
  function changeSort(column: 'name' | 'location' | 'genre' | 'colour') {
    resetPage()
    if (sort === column) setDirection(value => value === 'asc' ? 'desc' : 'asc')
    else { setSort(column); setDirection('asc') }
  }
  function toggle<T extends string | null>(value: T, selected: T[] | null, all: T[], update: (values: T[] | null) => void) {
    resetPage()
    const current = selected ?? all
    const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value]
    update(next.length === all.length ? null : next)
  }

  return <>
    <BoothHeader>
      {user && <ColourPreferences onSaved={ordered => {
        setAvailableColours(ordered.filter(colour => options.colours.includes(colour)))
        resetPage()
        setColourRevision(value => value + 1)
      }} />}
      {eventControl}
      <TextField type="search" size="small" label="搜索" placeholder={user ? '社团名、作者名、genre、tags、memo' : '社团名、作者名、genre、tags'} value={search}
        slotProps={{ htmlInput: { maxLength: 255 } }} sx={{ width: 320, maxWidth: '100%' }}
        onChange={event => {
          const value = event.target.value
          if (value.trim() !== search.trim()) resetPage()
          setSearch(value)
        }} />
      {user && <PixivMenu />}
    </BoothHeader>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
      已加载 {items.length} / {total} 个社团 · 向下滚动加载更多 · 点击社团查看详情
    </Typography>
    <TableContainer component={Paper} variant="outlined" sx={{ overflowX: 'auto' }}>
      <Table aria-label="Booth 社团列表" sx={{
        display: 'block', minWidth: 1208,
        '& thead, & tbody': { display: 'block' },
        '& tr': {
          display: 'grid', gridTemplateColumns: '104px 160px 160px 128px 240px 240px 136px 40px',
          justifyContent: 'space-around', borderBottom: 1, borderColor: 'divider',
        },
        '& td, & th': { boxSizing: 'border-box', minWidth: 0, borderBottom: 0 },
        '& td': { py: 0.5, px: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' },
        '& td:nth-of-type(2)': { py: 0, px: 0.75 },
        '& tbody tr': { minHeight: 112 },
        '& thead tr': { bgcolor: 'grey.50', alignItems: 'center' },
        '& th': { py: 1, px: 1, whiteSpace: 'nowrap' },
      }}>
        <TableHead><TableRow>
          <TableCell aria-label="颜色标记" sortDirection={sort === 'colour' ? direction : false}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {user && <>
              <Tooltip title="按颜色排序"><TableSortLabel aria-label="按颜色排序" active={sort === 'colour'} direction={sort === 'colour' ? direction : 'asc'}
                sx={{ width: 28, height: 28, justifyContent: 'center', '& .MuiTableSortLabel-icon': { opacity: 1, mx: 0 } }}
                onClick={() => changeSort('colour')} /></Tooltip>
              <Tooltip title="按收藏颜色筛选"><IconButton size="small" aria-label="筛选颜色" color={colours !== null && availableColours.some(colour => !colours.includes(colour)) ? 'primary' : 'default'} onClick={event => { setFilterKind('colour'); setFilterAnchor(event.currentTarget) }}>
                <SvgIcon fontSize="small" viewBox="0 0 24 24"><path d="M3 5h18v2H3zm4 6h10v2H7zm3 6h4v2h-4z" /></SvgIcon>
              </IconButton></Tooltip>
            </>}
          </TableCell>
          <TableCell align="center">社团图片</TableCell>
          <TableCell sortDirection={sort === 'name' ? direction : false}>
            <TableSortLabel active={sort === 'name'} direction={sort === 'name' ? direction : 'asc'} onClick={() => changeSort('name')}>社团 / 作者</TableSortLabel>
          </TableCell>
          <TableCell sortDirection={sort === 'location' ? direction : false}>
            <TableSortLabel active={sort === 'location'} direction={sort === 'location' ? direction : 'asc'} onClick={() => changeSort('location')}>位置</TableSortLabel>
            <Tooltip title="按日期和场馆筛选"><IconButton size="small" aria-label="筛选日期和场馆" color={days !== null || halls !== null ? 'primary' : 'default'} onClick={event => { setFilterKind('location'); setFilterAnchor(event.currentTarget) }}>
              <SvgIcon fontSize="small" viewBox="0 0 24 24"><path d="M3 5h18v2H3zm4 6h10v2H7zm3 6h4v2h-4z" /></SvgIcon>
            </IconButton></Tooltip>
          </TableCell>
          <TableCell sortDirection={sort === 'genre' ? direction : false}>
            <TableSortLabel active={sort === 'genre'} direction={sort === 'genre' ? direction : 'asc'} onClick={() => changeSort('genre')}>类别 / 标签</TableSortLabel>
            <Tooltip title="按类别筛选"><IconButton size="small" aria-label="筛选类别" color={genres !== null ? 'primary' : 'default'} onClick={event => { setFilterKind('genre'); setFilterAnchor(event.currentTarget) }}>
              <SvgIcon fontSize="small" viewBox="0 0 24 24"><path d="M3 5h18v2H3zm4 6h10v2H7zm3 6h4v2h-4z" /></SvgIcon>
            </IconButton></Tooltip>
          </TableCell>
          <TableCell>Memo</TableCell>
          <TableCell>Links</TableCell>
          <TableCell><span aria-label="操作">⋯</span></TableCell>
        </TableRow></TableHead>
        <TableBody>
          {items.map(booth => <TableRow key={booth.id} hover tabIndex={0} aria-label={`查看 ${booth.circle_name} 详情`}
            onClick={() => setSelected(booth)} onKeyDown={event => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault(); setSelected(booth)
              }
            }} sx={{ cursor: 'pointer', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}>
            <TableCell sx={{ alignItems: 'center' }}>{booth.colour && <Box role="img" aria-label={`颜色标记 ${booth.colour}`}
              sx={{ width: 20, height: 20, borderRadius: '50%', bgcolor: booth.colour }} />}</TableCell>
            <TableCell><BoothImages booth={booth} /></TableCell>
            <TableCell>
              <Typography sx={{ fontWeight: 700, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{booth.circle_name}</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{booth.author_name || '—'}</Typography>
            </TableCell>
            <TableCell><Typography>{locationLabel(booth)}</Typography><Typography variant="caption" color="text.secondary">{booth.dayLabel}</Typography></TableCell>
            <TableCell><Typography sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{booth.genre || '—'}</Typography><Typography variant="caption" color="text.secondary"
              sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{booth.tags || '—'}</Typography></TableCell>
            <TableCell><Typography sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
              {booth.memo?.trim() ? booth.memo : '—'}
            </Typography></TableCell>
            <TableCell><BoothLinks booth={booth} /></TableCell>
            <TableCell><Tooltip title="操作预留 · 点击查看详情"><IconButton size="small" aria-label={`${booth.circle_name} 操作（预留）`}>⋯</IconButton></Tooltip></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
      {!loading && !error && !items.length && <Typography sx={{ p: 5, textAlign: 'center', color: 'text.secondary' }}>没有符合条件的社团</Typography>}
    </TableContainer>
    <Box ref={sentinel} sx={{ py: 3, textAlign: 'center' }}>
      {loading && <CircularProgress size={24} aria-label="加载社团列表" />}
      {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
      {!loading && nextOffset !== null && <Button onClick={loadMore}>{error ? '重试加载' : '加载更多'}</Button>}
      {!loading && nextOffset === null && !!items.length && <Typography variant="body2" color="text.secondary">已加载全部匹配社团</Typography>}
    </Box>
    <Popover open={!!filterAnchor} anchorEl={filterAnchor} onClose={() => setFilterAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}>
      <Stack spacing={0.75} sx={{ p: 1.5, width: 480, maxWidth: 'calc(100vw - 32px)', boxSizing: 'border-box', maxHeight: '75vh', overflowY: 'auto', '& .MuiFormControlLabel-root': { m: 0 }, '& .MuiFormControlLabel-label': { fontSize: 14, whiteSpace: 'nowrap' }, '& .MuiCheckbox-root': { p: 0.5 }, '& .MuiCheckbox-root svg': { fontSize: 20 } }}>
        {filterKind === 'location' ? <>
        <Typography variant="subtitle2">日期</Typography>
        <Stack direction="row" sx={{ flexWrap: 'wrap', columnGap: 1, rowGap: 0 }}>
          <FormControlLabel label="全选日期" control={<Checkbox checked={days === null} indeterminate={days !== null && !!days.length}
            onChange={() => { resetPage(); setDays(days === null ? [] : null) }} />} />
          {options.days.map(day => <FormControlLabel key={day.weekday} label={`${day.label}(${day.weekday})`}
            control={<Checkbox checked={days === null || days.includes(day.weekday)} onChange={() => toggle(day.weekday, days, options.days.map(day => day.weekday), setDays)} />} />)}
        </Stack>
        <Typography variant="subtitle2">场馆</Typography>
        <Stack direction="row" sx={{ flexWrap: 'wrap', columnGap: 1, rowGap: 0 }}>
          <FormControlLabel label="全选场馆" control={<Checkbox checked={halls === null} indeterminate={halls !== null && !!halls.length}
            onChange={() => { resetPage(); setHalls(halls === null ? [] : null) }} />} />
          {options.halls.map(hall => <FormControlLabel key={hall} label={hall}
            control={<Checkbox checked={halls === null || halls.includes(hall)} onChange={() => toggle(hall, halls, options.halls, setHalls)} />} />)}
        </Stack>
        </> : filterKind === 'genre' ? <>
          <Typography variant="subtitle2">类别</Typography>
          <Stack direction="row" sx={{ flexWrap: 'wrap', columnGap: 1, rowGap: 0, '& .MuiFormControlLabel-label': { whiteSpace: 'normal', overflowWrap: 'anywhere' }, '& .MuiFormControlLabel-root': { maxWidth: '100%' } }}>
            <FormControlLabel label="全选类别" control={<Checkbox checked={genres === null} indeterminate={genres !== null && !!genres.length}
              onChange={() => { resetPage(); setGenres(genres === null ? [] : null) }} />} />
            {options.genres.map(genre => <FormControlLabel key={JSON.stringify(genre)} label={genre === null ? '未分类' : genre || '未分类（空文本）'}
              control={<Checkbox checked={genres === null || genres.includes(genre)} onChange={() => toggle(genre, genres, options.genres, setGenres)} />} />)}
          </Stack>
        </> : <>
          <Typography variant="subtitle2">收藏颜色</Typography>
          <FormControlLabel label="全选颜色" control={<Checkbox checked={colours === null} indeterminate={colours !== null && !!colours.length}
            onChange={() => { resetPage(); setColours(colours === null ? [] : null) }} />} />
          <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
            {availableColours.map(colour => <FormControlLabel key={colour}
              label={<Chip size="small" label={colour} sx={theme => ({ bgcolor: colour, color: theme.palette.getContrastText(colour) })} />}
              control={<Checkbox slotProps={{ input: { 'aria-label': `颜色 ${colour}` } }}
                checked={colours === null || colours.includes(colour)}
                onChange={() => toggle(colour, colours, allColours, setColours)} />} />)}
          </Stack>
          <FormControlLabel label="未收藏" control={<Checkbox checked={colours === null || colours.includes(null)}
            onChange={() => toggle(null, colours, allColours, setColours)} />} />
        </>}
        <Stack direction="row" sx={{ justifyContent: 'flex-end', gap: 1 }}>
          <Button size="small" onClick={() => {
            if (filterKind === 'genre') {
              if (genres !== null) { resetPage(); setGenres(null) }
            } else if (filterKind === 'colour') {
              if (colours === null || colours.length !== availableColours.length || colours.includes(null)) {
                resetPage()
                setColours(availableColours)
              }
            } else {
              if (days !== null || halls !== null) resetPage()
              setDays(null); setHalls(null)
            }
          }}>重置筛选</Button>
          <Button size="small" variant="contained" onClick={() => setFilterAnchor(null)}>完成</Button>
        </Stack>
      </Stack>
    </Popover>
    <BoothDetail key={selected?.id ?? 'closed'} booth={selected} onClose={() => setSelected(null)} />
  </>
}

function BoothCatalog() {
  const { user } = useAuth()
  const [options, setOptions] = useState<BoothOptions | null>(null)
  const [eventId, setEventId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void readBoothApi<BoothOptions>(`/options${eventId ? `?eventId=${eventId}` : ''}`, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setOptions(result); setError(null) } })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          console.error('Booth options failed:', reason)
          setError(reason instanceof Error ? reason.message : '筛选项加载失败')
        }
      })
    return () => controller.abort()
  }, [eventId, retry])
  const eventControl = !!options?.events.length && <TextField select size="small" label="活动" value={options.event?.eventId ?? ''} sx={{ minWidth: 120 }}
        onChange={event => { setOptions(null); setError(null); setEventId(event.target.value) }}>
        {options.events.map(event => <MenuItem key={event.eventId} value={event.eventId}>C{event.comiket}</MenuItem>)}
      </TextField>
  return <Box sx={{ maxWidth: 1700, mx: 'auto', p: { xs: 1.5, md: 3 } }}>
    {!options?.event && <BoothHeader>{user && <ColourPreferences />}{eventControl}</BoothHeader>}
    {error && <Alert severity="error" action={<Button onClick={() => { setError(null); setRetry(value => value + 1) }}>重试</Button>}>{error}</Alert>}
    {!options && !error && <CircularProgress aria-label="加载活动和筛选项" size={24} />}
    {options?.warnings.map(warning => <Alert key={warning} severity="warning" sx={{ mb: 2 }}>{warning}</Alert>)}
    {options && (options.event
      ? <BoothTable key={options.event.eventId} options={options} eventControl={eventControl} />
      : <Alert severity="info">数据库中还没有 booth 数据，请先在爬虫 Dashboard 采集。</Alert>)}
  </Box>
}

export default function BoothList() {
  const { user, loading } = useAuth()
  return loading
    ? <CircularProgress aria-label="加载登录状态" size={24} />
    : <BoothCatalog key={user?.id ?? 'anonymous'} />
}
