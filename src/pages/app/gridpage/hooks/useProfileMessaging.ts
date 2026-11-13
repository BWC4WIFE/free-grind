import { useCallback } from "react";
import toast from "react-hot-toast";
import { useTranslation } from "react-i18next";
import { useApiFunctions } from "../../../../hooks/useApiFunctions";

/** Sends messages straight from a profile, without opening the conversation. */
export function useProfileMessaging() {
	const { t } = useTranslation();
	const apiFunctions = useApiFunctions();

	const handleSendQuickMessage = useCallback(
		async (targetProfileId: string, text: string): Promise<boolean> => {
			try {
				await apiFunctions.sendText({ targetProfileId: Number(targetProfileId), text });
				toast.success(t("profile_details.quick_message_sent", "Message sent"));
				return true;
			} catch (error) {
				toast.error(error instanceof Error ? error.message : t("chat.errors.send_failed"));
				return false;
			}
		},
		[apiFunctions, t],
	);

	const handleSendProfilePhotoReply = useCallback(
		async (targetProfileId: string, imageHash: string, text: string): Promise<void> => {
			try {
				await apiFunctions.sendMessage({
					type: "ProfilePhotoReply",
					target: { type: "Direct", targetId: Number(targetProfileId) },
					body: { imageHash, photoContentReply: text },
				});
				toast.success(t("chat.toasts.photo_reply_sent", { defaultValue: "Reply sent" }));
			} catch (error) {
				toast.error(error instanceof Error ? error.message : t("chat.errors.send_failed"));
			}
		},
		[apiFunctions, t],
	);

	return { handleSendQuickMessage, handleSendProfilePhotoReply };
}
