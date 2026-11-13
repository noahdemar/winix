/* Needs a.so (recorded in dylink.0): calls into it and reads its data. */
int a_sum(void);
extern int a_data;
int b_sum(void) { return a_sum() + a_data; }
