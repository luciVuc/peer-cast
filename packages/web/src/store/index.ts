import { configureStore } from "@reduxjs/toolkit";
import {
  useDispatch,
  useSelector,
  type TypedUseSelectorHook,
} from "react-redux";
import { api } from "./api";
import authReducer from "./authSlice";
import toastReducer from "./toastSlice";
import broadcastReducer from "./broadcastSlice";

export const store = configureStore({
  reducer: {
    auth: authReducer,
    toast: toastReducer,
    broadcast: broadcastReducer,
    [api.reducerPath]: api.reducer,
  },
  middleware: (getDefault) => getDefault().concat(api.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector: TypedUseSelectorHook<RootState> = useSelector;
