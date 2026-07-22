import { useState } from 'react';
import { X, CheckCircle, Warning, Note } from '@phosphor-icons/react';
import type { StockCountVarianceReview } from '../../../types/app';

interface StockVarianceReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  reviews: StockCountVarianceReview[];
  onReviewSubmit: (reviewId: string, status: 'approved' | 'rejected', note: string) => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function StockVarianceReviewModal({
  isOpen,
  onClose,
  reviews,
  onReviewSubmit,
  loading,
  error,
}: StockVarianceReviewModalProps) {
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({});

  if (!isOpen) return null;

  const handleNoteChange = (id: string, value: string) => {
    setReviewNote((prev) => ({ ...prev, [id]: value }));
  };

  const pendingReviews = reviews.filter((r) => r.status === 'pending');

  return (
    <div className="stock-variance-modal-backdrop" role="presentation">
      <section aria-modal="true" className="stock-variance-modal" role="dialog">
        <header className="stock-variance-modal__header">
          <div>
            <h3>ตรวจสอบยอดเบี่ยงเบนผิดปกติ</h3>
            <p className="muted">
              พบ {pendingReviews.length} รายการที่รอการตรวจสอบ (requires_daily_count = true)
            </p>
          </div>
          <button
            onClick={onClose}
            className="stock-variance-modal__close"
            aria-label="ปิดหน้าต่างตรวจสอบ"
          >
            <X size={20} />
          </button>
        </header>

        <div className="stock-variance-modal__body">
          {error && (
            <div className="error-text stock-v2-feedback">
              ⚠️ {error}
            </div>
          )}

          {pendingReviews.length === 0 ? (
            <div className="stock-variance-modal__empty">
              <CheckCircle size={40} weight="fill" />
              <strong>ไม่มีรายการเบี่ยงเบนที่รอตรวจสอบ</strong>
              <p className="muted">รายการที่อนุมัติหรือปฏิเสธแล้วจะไม่แสดงในรายการนี้</p>
            </div>
          ) : (
            pendingReviews.map((review) => (
              <div
                key={review.id}
                className="stock-variance-review"
              >
                <div className="stock-variance-review__header">
                  <div>
                    <h4>{review.location_name} · {review.ice_type_name}</h4>
                    <p className="muted">วันที่บริการ: {review.service_date}</p>
                  </div>
                  <span className="status-badge status-badge--neutral stock-variance-review__status">
                    <Warning size={12} weight="fill" /> รออนุมัติยอดต่าง
                  </span>
                </div>

                <div className="stock-variance-review__quantities">
                  <div>
                    <small>ในระบบ</small>
                    <strong>
                      {review.system_quantity} {review.unit}
                    </strong>
                  </div>
                  <div>
                    <small>นับจริง</small>
                    <strong>
                      {review.actual_quantity} {review.unit}
                    </strong>
                  </div>
                  <div>
                    <small>ผลต่าง</small>
                    <strong className="error-text">
                      {review.variance_quantity} {review.unit}
                    </strong>
                  </div>
                </div>

                <div className="stock-variance-review__form">
                  <label>
                    <Note size={14} />
                    <input
                      type="text"
                      placeholder="ระบุหมายเหตุการอนุมัติ (เช่น ตรวจสอบความถูกต้องแล้ว, ยอมรับยอดละลาย)..."
                      value={reviewNote[review.id] ?? ''}
                      onChange={(e) => handleNoteChange(review.id, e.target.value)}
                      disabled={loading}
                    />
                  </label>

                  <div className="stock-variance-review__actions">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => onReviewSubmit(review.id, 'rejected', reviewNote[review.id] ?? '')}
                      className="secondary-button stock-variance-review__reject"
                    >
                      ปฏิเสธยอด (Reject)
                    </button>
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => onReviewSubmit(review.id, 'approved', reviewNote[review.id] ?? '')}
                      className="primary-button"
                    >
                      อนุมัติยอด (Approve)
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <footer className="stock-variance-modal__footer">
          <button
            onClick={onClose}
            className="secondary-button"
          >
            ปิดหน้าจอ
          </button>
        </footer>
      </section>
    </div>
  );
}
