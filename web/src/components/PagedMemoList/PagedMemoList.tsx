import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpIcon, CombineIcon, XIcon } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import { MentionResolutionProvider } from "@/components/MemoContent/MentionResolutionContext";
import { deriveDefaultCreateTimeFromFilters } from "@/components/MemoEditor/utils/deriveDefaultCreateTime";
import { Button } from "@/components/ui/button";
import { userServiceClient } from "@/connect";
import { useMemoFilterContext } from "@/contexts/MemoFilterContext";
import { DEFAULT_LIST_MEMOS_PAGE_SIZE } from "@/helpers/consts";
import { useDeleteMemo, useInfiniteMemos, useUpdateMemo } from "@/hooks/useMemoQueries";
import { userKeys } from "@/hooks/useUserQueries";
import { AttachmentSchema } from "@/types/proto/api/v1/attachment_service_pb";
import { State } from "@/types/proto/api/v1/common_pb";
import type { Memo } from "@/types/proto/api/v1/memo_service_pb";
import { useTranslate } from "@/utils/i18n";
import ConfirmDialog from "../ConfirmDialog";
import MemoEditor from "../MemoEditor";
import MemoFilters from "../MemoFilters";
import Placeholder from "../Placeholder";
import Skeleton from "../Skeleton";

interface Props {
  renderer: (memo: Memo, selectionProps?: MemoSelectionRenderProps) => ReactElement;
  listSort?: (list: Memo[]) => Memo[];
  state?: State;
  orderBy?: string;
  filter?: string;
  pageSize?: number;
  showCreator?: boolean;
  enabled?: boolean;
  enableSelection?: boolean;
  /** When true, render the inline MemoEditor above the list (e.g. on the Home page). */
  showMemoEditor?: boolean;
}

interface MemoSelectionRenderProps {
  selectionMode: boolean;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onSelect?: () => void;
}

function useAutoFetchWhenNotScrollable({
  hasNextPage,
  isFetchingNextPage,
  memoCount,
  onFetchNext,
}: {
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  memoCount: number;
  onFetchNext: () => Promise<unknown>;
}) {
  const autoFetchTimeoutRef = useRef<number | null>(null);

  const isPageScrollable = useCallback(() => {
    const documentHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    return documentHeight > window.innerHeight + 100;
  }, []);

  const checkAndFetchIfNeeded = useCallback(async () => {
    if (autoFetchTimeoutRef.current) {
      clearTimeout(autoFetchTimeoutRef.current);
    }

    await new Promise((resolve) => setTimeout(resolve, 200));

    const shouldFetch = !isPageScrollable() && hasNextPage && !isFetchingNextPage && memoCount > 0;

    if (shouldFetch) {
      await onFetchNext();

      autoFetchTimeoutRef.current = window.setTimeout(() => {
        void checkAndFetchIfNeeded();
      }, 500);
    }
  }, [hasNextPage, isFetchingNextPage, memoCount, isPageScrollable, onFetchNext]);

  useEffect(() => {
    if (!isFetchingNextPage && memoCount > 0) {
      void checkAndFetchIfNeeded();
    }
  }, [memoCount, isFetchingNextPage, checkAndFetchIfNeeded]);

  useEffect(() => {
    return () => {
      if (autoFetchTimeoutRef.current) {
        clearTimeout(autoFetchTimeoutRef.current);
      }
    };
  }, []);
}

const PagedMemoList = (props: Props) => {
  const t = useTranslate();
  const queryClient = useQueryClient();
  const { filters } = useMemoFilterContext();
  const { mutateAsync: updateMemo } = useUpdateMemo();
  const { mutateAsync: deleteMemo } = useDeleteMemo();

  const showMemoEditor = props.showMemoEditor ?? false;
  const enableSelection = props.enableSelection ?? false;
  const defaultCreateTime = useMemo(() => deriveDefaultCreateTimeFromFilters(filters), [filters]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMemoNames, setSelectedMemoNames] = useState<string[]>([]);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [isMerging, setIsMerging] = useState(false);

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading } = useInfiniteMemos(
    {
      state: props.state || State.NORMAL,
      orderBy: props.orderBy || "create_time desc",
      filter: props.filter,
      pageSize: props.pageSize || DEFAULT_LIST_MEMOS_PAGE_SIZE,
    },
    { enabled: props.enabled ?? true },
  );

  // Flatten pages into a single array of memos
  const memos = useMemo(() => data?.pages.flatMap((page) => page.memos) || [], [data]);

  // Apply custom sorting if provided, otherwise use memos directly
  const sortedMemoList = useMemo(() => (props.listSort ? props.listSort(memos) : memos), [memos, props.listSort]);
  const selectedMemos = useMemo(
    () => selectedMemoNames.map((name) => sortedMemoList.find((memo) => memo.name === name)).filter((memo): memo is Memo => Boolean(memo)),
    [selectedMemoNames, sortedMemoList],
  );

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedMemoNames([]);
  }, []);

  const startSelectionMode = useCallback((memoName: string) => {
    setSelectionMode(true);
    setSelectedMemoNames([memoName]);
  }, []);

  const setMemoSelected = useCallback((memoName: string, selected: boolean) => {
    setSelectedMemoNames((current) => {
      if (selected) {
        return current.includes(memoName) ? current : [...current, memoName];
      }
      return current.filter((name) => name !== memoName);
    });
  }, []);

  const handleMergeSelectedMemos = useCallback(async () => {
    if (selectedMemos.length < 2) {
      return;
    }

    const memosToMerge = [...selectedMemos].sort((a, b) => {
      const aTime = a.createTime ? timestampDate(a.createTime).getTime() : 0;
      const bTime = b.createTime ? timestampDate(b.createTime).getTime() : 0;
      return aTime - bTime;
    });
    const targetMemo = memosToMerge[0];
    const sourceMemos = memosToMerge.slice(1);
    const attachmentNames = new Set<string>();
    const attachments = memosToMerge
      .flatMap((memo) => memo.attachments)
      .filter((attachment) => {
        if (attachmentNames.has(attachment.name)) {
          return false;
        }
        attachmentNames.add(attachment.name);
        return true;
      });
    const mergedContent = memosToMerge
      .map((memo) => ({ memo, content: memo.content.trim() }))
      .filter(({ content }) => content)
      .map(({ memo, content }) => {
        const createTime = memo.createTime ? timestampDate(memo.createTime).toLocaleString() : memo.name;
        return `### ${createTime}\n\n${content}`;
      })
      .join("\n\n---\n\n");

    try {
      setIsMerging(true);
      await updateMemo({
        update: {
          name: targetMemo.name,
          content: mergedContent,
          attachments: attachments.map((attachment) => create(AttachmentSchema, { name: attachment.name })),
        },
        updateMask: ["content", "attachments"],
      });
      for (const memo of sourceMemos) {
        await deleteMemo(memo.name);
      }
      toast.success(`Merged ${memosToMerge.length} memos`);
      setSelectedMemoNames([]);
      setSelectionMode(false);
    } catch (error) {
      console.error("Failed to merge memos", error);
      toast.error("Failed to merge memos");
    } finally {
      setIsMerging(false);
    }
  }, [deleteMemo, selectedMemos, updateMemo]);

  // Prefetch creators when new data arrives to improve performance
  useEffect(() => {
    if (!data?.pages || !props.showCreator) return;

    const lastPage = data.pages[data.pages.length - 1];
    if (!lastPage?.memos) return;

    const uniqueCreators = Array.from(new Set(lastPage.memos.map((memo) => memo.creator)));
    for (const creator of uniqueCreators) {
      void queryClient.prefetchQuery({
        queryKey: userKeys.detail(creator),
        queryFn: async () => {
          const user = await userServiceClient.getUser({ name: creator });
          return user;
        },
        staleTime: 1000 * 60 * 5,
      });
    }
  }, [data?.pages, props.showCreator, queryClient]);

  // Auto-fetch hook: fetches more content when page isn't scrollable
  useAutoFetchWhenNotScrollable({
    hasNextPage,
    isFetchingNextPage,
    memoCount: sortedMemoList.length,
    onFetchNext: fetchNextPage,
  });

  // Infinite scroll: fetch more when user scrolls near bottom
  useEffect(() => {
    if (!hasNextPage) return;

    const handleScroll = () => {
      const nearBottom = window.innerHeight + window.scrollY >= document.body.offsetHeight - 300;
      if (nearBottom && !isFetchingNextPage) {
        fetchNextPage();
      }
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const children = (
    <MentionResolutionProvider contents={sortedMemoList.map((memo) => memo.content)}>
      <div className="flex flex-col justify-start w-full max-w-2xl mx-auto">
        {/* Show skeleton loader during initial load */}
        {isLoading ? (
          <Skeleton showCreator={props.showCreator} count={4} />
        ) : (
          <>
            {showMemoEditor ? (
              <MemoEditor
                className="mb-2"
                cacheKey="home-memo-editor"
                placeholder={t("editor.any-thoughts")}
                defaultCreateTime={defaultCreateTime}
              />
            ) : null}
            <MemoFilters />
            {enableSelection && selectionMode && (
              <div className="sticky top-2 z-30 mb-2 flex w-full flex-row items-center justify-between gap-2 rounded-lg border border-border bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
                <span className="truncate text-sm text-muted-foreground">{selectedMemoNames.length} selected</span>
                <div className="flex shrink-0 flex-row items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={toggleSelectionMode}>
                    <XIcon className="mr-1 size-4" />
                    Cancel
                  </Button>
                  <Button size="sm" disabled={selectedMemoNames.length < 2 || isMerging} onClick={() => setMergeDialogOpen(true)}>
                    <CombineIcon className="mr-1 size-4" />
                    Merge
                  </Button>
                </div>
              </div>
            )}
            {sortedMemoList.map((memo) =>
              props.renderer(
                memo,
                enableSelection
                  ? {
                      selectionMode,
                      selected: selectedMemoNames.includes(memo.name),
                      onSelectedChange: (selected) => setMemoSelected(memo.name, selected),
                      onSelect: selectionMode ? undefined : () => startSelectionMode(memo.name),
                    }
                  : undefined,
              ),
            )}

            {/* Loading indicator for pagination */}
            {isFetchingNextPage && <Skeleton showCreator={props.showCreator} count={2} />}

            {/* Empty state or back-to-top button */}
            {!isFetchingNextPage && (
              <>
                {!hasNextPage && sortedMemoList.length === 0 ? (
                  <Placeholder variant="empty" message={t("message.no-data")} />
                ) : (
                  <div className="w-full opacity-70 flex flex-row justify-center items-center my-4">
                    <BackToTop />
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={mergeDialogOpen}
        onOpenChange={setMergeDialogOpen}
        title="Merge selected memos?"
        description="The oldest selected memo will be kept. Content and attachments from the other selected memos will be moved into it, then those source memos will be deleted."
        confirmLabel="Merge"
        cancelLabel="Cancel"
        onConfirm={handleMergeSelectedMemos}
      />
    </MentionResolutionProvider>
  );

  return children;
};

const BackToTop = () => {
  const t = useTranslate();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      const shouldShow = window.scrollY > 400;
      setIsVisible(shouldShow);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToTop = () => {
    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  };

  // Don't render if not visible
  if (!isVisible) {
    return null;
  }

  return (
    <Button variant="ghost" onClick={scrollToTop}>
      {t("router.back-to-top")}
      <ArrowUpIcon className="ml-1 w-4 h-auto" />
    </Button>
  );
};

export default PagedMemoList;
